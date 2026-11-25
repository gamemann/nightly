// ASSETS: coverage. For every asset row, which of model / texture / sound / anim / icon / licence is mapped, and how well:
//   ok           mapped to a real file
//   placeholder  mapped, but to a stand-in (flat colour or a vertex-coloured primitive instead of a texture, synth-only sound, static/procedural clips only)
//   stale        a link exists but points at nothing (the model file is gone, a sound event resolves to no file and no synth)
//   missing      nothing mapped although the asset's kind needs it
//   na           nothing mapped and the kind does not need it
// A row is orphaned when its pack has no source, the source is disabled, or the source root is gone: its links cannot be refreshed.
// Everything is data: which dimensions a kind needs is the kind budget's `needs` list (default: model + licence, texture when the
// budget sets min_tex/require_skin, sound when require_sounds, anim when required_clips); where icons live is the source config's
// `icons` globs (matched to an asset by file stem; `iconSources` lists packs whose icons this source reuses); licences come from the source's `licenceRules` ([{match: regex on the model
// path, licence}]), then its `licenceFile` (default licence.json: [{paths: [prefix], licence}], the longest prefix wins); a declared
// licence of "none stated" / "unknown" counts as missing. A model is stale when its file is gone from the source root (or the copy is gone).
// The CLI computes it (`nightly assets coverage`, and after every scan / ingest) into the `coverage` column; the panel only aggregates.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { effective, globToRe } from './assets-sources.mjs'
import { walk } from './assets-scan.mjs'

export const DIMS = ['model', 'texture', 'sound', 'anim', 'icon', 'licence']
export const STATUSES = ['ok', 'placeholder', 'stale', 'missing', 'na']

/** The dimensions a kind needs, from its budget: an explicit `needs` list, else derived from the budget's own requirements. */
export function needsOf(budget = {}) {
    if (Array.isArray(budget.needs)) return budget.needs.filter((d) => DIMS.includes(d))
    const n = ['model', 'licence']
    if (budget.min_tex || budget.require_skin) n.push('texture')
    if (budget.require_sounds) n.push('sound')
    if (budget.required_clips?.length) n.push('anim')
    return n
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]/g, '')
/** Name stems an asset can be matched by: the model file stem and the last segment of its id. */
export function stemsOf(row, data) {
    const s = new Set()
    const glb = data?.model?.glb
    if (glb) s.add(norm(path.basename(glb)))
    const id = String(row.weaponId ?? '')
    s.add(norm(id.split('__').pop()))
    s.delete('')
    return [...s]
}

/** Licence of a model path: rules first (regex on the path), then the licence file's longest matching path prefix. */
export function licenceOf(rel, { rules = [], entries = [] } = {}) {
    if (!rel) return ''
    for (const r of rules) if (new RegExp(r.match, 'i').test(rel)) return r.licence
    let best = null
    for (const e of entries) for (const p of e.paths ?? []) {
        const pre = String(p).replace(/^\.?\//, '')
        if ((pre === '' || rel === pre || rel.startsWith(pre.endsWith('/') ? pre : `${pre}/`)) && (!best || pre.length > best.len)) best = { len: pre.length, licence: e.licence }
    }
    return best?.licence ?? ''
}

/** Per-source lookups, built once per run: root state, icon stems and licence entries. */
export function sourceIndex(src) {
    const cfg = effective(src.config ?? {}), root = src.root ?? ''
    const rootOk = !!root && existsSync(/*turbopackIgnore: true*/ root)
    const icons = new Set()
    if (rootOk && cfg.icons?.length) {
        const re = cfg.icons.map(globToRe)
        walk(root, cfg.exclude, (_abs, rel) => { if (re.some((r) => r.test(rel))) icons.add(norm(path.basename(rel))) })
    }
    let entries = []
    const lf = rootOk ? path.join(/*turbopackIgnore: true*/ root, cfg.licenceFile ?? 'licence.json') : ''
    if (lf && existsSync(/*turbopackIgnore: true*/ lf)) { try { const j = JSON.parse(readFileSync(/*turbopackIgnore: true*/ lf, 'utf8')); entries = Array.isArray(j) ? j : Array.isArray(j.entries) ? j.entries : [] } catch { entries = [] } }
    return { enabled: !!src.enabled, root, rootOk, icons, rules: cfg.licenceRules ?? [], entries, iconSources: cfg.iconSources ?? [] }
}

/** A game that uses a pack's weapons shows that pack's icons: each source's `iconSources` names packs whose icon stems count for it too. */
export function linkIcons(idx) {
    for (const i of idx.values()) for (const n of i.iconSources ?? []) for (const st of idx.get(n)?.icons ?? []) i.icons.add(st)
}

/** Declared licences that grant nothing: the asset still needs a real one. */
export const NO_LICENCE = /^\s*(none|none stated|unknown|unlicensed|n\/a|tbd|\?)\s*$/i
const flagSet = (data) => new Set((data?.flags ?? []).map((f) => f.code))
/** The coverage of one row. `idx` is its source's sourceIndex (undefined = no source); `exists` checks a file path. */
export function coverageOf(row, data, { needs, idx, exists = existsSync }) {
    const flags = flagSet(data), need = new Set(needs)
    const raw = {}
    const glb = data?._files?.glb ?? ''
    const rel = data?.model?.glb ?? ''
    const gone = (glb && !exists(/*turbopackIgnore: true*/ glb)) || (rel && idx?.rootOk && !path.isAbsolute(rel) && !exists(path.join(/*turbopackIgnore: true*/ idx.root, rel)))
    raw.model = !Number(row.hasModel) ? 'missing' : gone ? 'stale' : 'ok'
    raw.texture = Number(row.texCount) > 0 ? (flags.has('FLAT_TEX') ? 'placeholder' : 'ok') : (flags.has('FLAT_COLOUR') || flags.has('PRIMITIVE_MESH')) && Number(row.hasModel) ? 'placeholder' : 'missing'
    const snd = data?.sounds ?? []
    const real = snd.filter((s) => s.file || Number(s.len) > 0 || Number(s.bytes) > 0)
    raw.sound = !snd.length ? 'missing' : real.length ? 'ok' : snd.some((s) => s.synth) ? 'placeholder' : 'stale'
    const clips = data?.animations ?? []
    raw.anim = !clips.length ? 'missing' : clips.every((a) => (a.flags ?? []).some((f) => f === 'static' || f === 'procedural')) ? 'placeholder' : 'ok'
    const stems = stemsOf(row, data)
    raw.icon = idx?.icons.size && stems.some((s) => idx.icons.has(s)) ? 'ok' : 'missing'
    const lic = idx ? licenceOf(data?.model?.glb ?? '', idx) : ''
    raw.licence = lic && !NO_LICENCE.test(lic) ? 'ok' : 'missing'
    const s = {}
    for (const d of DIMS) s[d] = raw[d] === 'missing' && !need.has(d) ? 'na' : raw[d]
    const orphan = !idx ? 'no-source' : !idx.enabled ? 'disabled' : !idx.rootOk ? 'root-missing' : ''
    const gaps = DIMS.filter((d) => need.has(d) && s[d] !== 'ok')
    return { s, o: orphan, g: gaps, ...(lic ? { l: lic } : {}) }
}

/** Aggregate rows {pack, kind, coverage(JSON text or object)} into the matrix the CLI prints and the panel shows. */
export function aggregate(rows) {
    const packs = new Map(), totals = { rows: 0, complete: 0, orphan: 0, dims: Object.fromEntries(DIMS.map((d) => [d, Object.fromEntries(STATUSES.map((x) => [x, 0]))])) }
    for (const r of rows) {
        const c = typeof r.coverage === 'string' ? (r.coverage ? JSON.parse(r.coverage) : null) : r.coverage
        if (!c) continue
        let p = packs.get(r.pack)
        if (!p) packs.set(r.pack, p = { pack: r.pack, rows: 0, complete: 0, orphan: '', kinds: new Map() })
        let k = p.kinds.get(r.kind)
        if (!k) p.kinds.set(r.kind, k = { kind: r.kind, rows: 0, complete: 0, gaps: Object.fromEntries(DIMS.map((d) => [d, 0])), dims: Object.fromEntries(DIMS.map((d) => [d, Object.fromEntries(STATUSES.map((x) => [x, 0]))])) })
        p.rows++; k.rows++; totals.rows++
        if (c.o) { p.orphan = c.o; totals.orphan++ }
        if (!c.g.length) { p.complete++; k.complete++; totals.complete++ }
        for (const d of c.g) k.gaps[d]++
        for (const d of DIMS) { k.dims[d][c.s[d]]++; totals.dims[d][c.s[d]]++ }
    }
    const list = [...packs.values()].sort((a, b) => a.pack.localeCompare(b.pack)).map((p) => ({ ...p, kinds: [...p.kinds.values()].sort((a, b) => b.rows - a.rows) }))
    return { totals, packs: list }
}

/** Recompute the coverage column of every row (or of `only` packs) with node:sqlite. Returns the aggregate. */
export function refresh(db, { only, exists = existsSync } = {}) {
    const kinds = db.prepare('SELECT key, budget FROM AssetKind').all()
    const needs = new Map(kinds.map((k) => [k.key, needsOf(JSON.parse(k.budget || '{}'))]))
    const idx = new Map(db.prepare('SELECT * FROM AssetSource').all().map((s) => [s.name, sourceIndex({ ...s, config: JSON.parse(s.config || '{}') })]))
    linkIcons(idx)
    const rows = db.prepare('SELECT id, pack, weaponId, kind, hasModel, texCount, soundCount, animCount, data, coverage FROM AssetWeapon').all()
    const upd = db.prepare('UPDATE AssetWeapon SET coverage = ? WHERE id = ?')
    const out = []
    db.exec('BEGIN')
    try {
        for (const r of rows) {
            if (only && !only.includes(r.pack)) { out.push({ pack: r.pack, kind: r.kind, coverage: r.coverage }); continue }
            let data = {}
            try { data = JSON.parse(r.data || '{}') } catch { data = {} }
            const c = coverageOf(r, data, { needs: needs.get(r.kind) ?? needsOf({}), idx: idx.get(r.pack), exists })
            upd.run(JSON.stringify(c), r.id)
            out.push({ pack: r.pack, kind: r.kind, coverage: c })
        }
        db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    return aggregate(out)
}

/** Sources with no rows at all (empty globs or an empty checkout): listed beside the matrix so they are not silently invisible. */
export function emptySources(db) {
    return db.prepare('SELECT s.name, s.enabled, s.root FROM AssetSource s WHERE NOT EXISTS (SELECT 1 FROM AssetWeapon w WHERE w.pack = s.name) ORDER BY s.name').all()
        .map((s) => ({ name: s.name, enabled: !!s.enabled, rootOk: !!s.root && existsSync(/*turbopackIgnore: true*/ s.root) }))
}

/** Plain-text matrix: one line per pack and kind, the gap count per needed dimension. */
export function text(m, empty = []) {
    const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0)
    const head = `${'pack / kind'.padEnd(40)} ${'rows'.padStart(5)} ${'done'.padStart(5)}  ${DIMS.map((d) => d.slice(0, 7).padStart(7)).join(' ')}   (gaps: needed but not ok)`
    const lines = [head]
    for (const p of m.packs) {
        lines.push(`${(p.pack + (p.orphan ? ` [${p.orphan}]` : '')).padEnd(40)} ${String(p.rows).padStart(5)} ${String(pct(p.complete, p.rows) + '%').padStart(5)}`)
        for (const k of p.kinds) lines.push(`  ${k.kind.padEnd(38)} ${String(k.rows).padStart(5)} ${String(pct(k.complete, k.rows) + '%').padStart(5)}  ${DIMS.map((d) => String(k.gaps[d] || '.').padStart(7)).join(' ')}`)
    }
    const t = m.totals
    lines.push('', `${t.rows} rows, ${t.complete} complete (${pct(t.complete, t.rows)}%), ${t.orphan} orphaned`)
    for (const d of DIMS) lines.push(`  ${d.padEnd(8)} ${STATUSES.map((x) => `${x} ${t.dims[d][x]}`).join('  ')}`)
    if (empty.length) lines.push('', `sources with no rows: ${empty.map((s) => `${s.name}${s.enabled ? '' : ' (off)'}${s.rootOk ? '' : ' (root missing)'}`).join(', ')}`)
    return lines.join('\n')
}
