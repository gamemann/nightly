// RSI flag definitions (RsiFlag rows): what the board does with an audit flag code. `match` is a regex over the code; the first
// row by sort with a domain decides the board domain, the first with an action gives the finding's next action. The generic
// rows below are seeded once (an empty table after that stays empty: the code falls back to them only when the table has none).
// Workspace-specific advice (a tool path, a LOOK key) belongs in the rows, never here: `nightly rsi flag set` or /assets/sources.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FALLBACK_DOMAIN = 'models'
export const FALLBACK_ACTION = 'Fix in the asset, then re-run the audit (nightly assets refresh)'
export const DOMAINS = ['models', 'textures', 'animations', 'sounds']

/** Generic seed: [match, domain, action, label]. Sorted by position (x10). */
export const SEED_FLAGS = [
    ['^(VERY_)?LOW_TRIS$', '', 'Remodel with bevels and separate materials up to the triangle target (fix agent, free/own assets only)', 'Too few triangles for the kind'],
    ['^FACETED$|^PRIMITIVE_', '', 'Rebuild the mesh with smooth normals / real shape instead of primitives', 'Flat-shaded or primitive mesh'],
    ['^HIGH_TRIS$', '', 'Decimate the mesh or add LODs to bring the triangle count under the kind budget', 'Over the triangle budget'],
    ['^NO_LODS$', '', 'Add LOD levels (nodes named <mesh>_lod1, _lod2) so distant instances render cheaper', 'No LOD levels'],
    ['^NO_SKIN$|^FEW_BONES$|^MANY_BONES$', '', 'Fix the rig: one skin, a bone count inside the kind budget', 'Rig outside the kind budget'],
    ['^MISSING_ANIM_SET$|^NO_ANIM_CLIPS$', '', 'Add the missing animation clips (idle, walk, run ...) so the model is not stuck in a T-pose', 'Missing animation clips'],
    ['^SCALE_', '', 'Rescale the model to real-world size (metres) at export', 'Wrong real-world scale'],
    ['^PIVOT_OFF$', '', 'Move the origin to the base or centre of the model at export', 'Origin off the base/centre'],
    ['^NO_MODEL$', '', 'Add or fix the model file in the pack, then re-run the audit', 'Model file missing'],
    ['^FEW_MATERIALS$', '', 'Split the mesh into separate materials (body, metal, grip, glass)', 'Too few materials'],
    ['^LOSSY_TEX$', '', 'Raise the import quality for this tier (lossless, VRAM or BasisU) within the pack size limit', 'Lossy texture import'],
    ['^LOW_TEX$|^NO_TEXTURES$', '', 'Bake or author textures at the tier target size', 'Textures under the tier size'],
    ['^FLAT_COLOUR$', '', 'Nothing to fix: a palette model by design. Author textures only if its kind needs them', 'Palette (flat colour) model'],
    ['^FLAT_TEX$', '', 'Rebake the albedo with wear and detail so it is not near-flat', 'Near-flat albedo'],
    ['TEX|NORMAL|ORM', '', 'Fix the texture set (power-of-two sizes, normal and roughness/metallic maps)', 'Texture set problem'],
    ['BOLT|CYCLE', '', 'Add the bolt cycle clip to the model or procedural reload, then check the GPU filmstrip', 'No bolt cycle'],
    ['MAG_STATIC|NO_MAG|STATIC_CLIP|CLIP', '', 'Animate the clip (magazine travels in reload) and check the GPU filmstrip', 'Static magazine/clip'],
    ['SOUND', 'sounds', 'Add free/own sound files named after the asset id', 'Sounds missing'],
    ['^(?!NO_MODEL).*(TEX|NORMAL|ORM|FLAT_COLOUR)', 'textures', '', 'Texture flags (judged per tier)'],
    ['CLIP|MAG|ANIM|ARMS|BOLT|CYCLE', 'animations', '', 'Animation flags'],
    ['.*', FALLBACK_DOMAIN, FALLBACK_ACTION, 'Anything else'],
].map(([match, domain, action, label], i) => ({ match, domain, action, label, sort: (i + 1) * 10 }))

const MIGRATION = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'migrations', '20261206000000_rsi_flags', 'migration.sql')
const SEEDED = 'rsiFlagsSeeded'

/** Create the table and seed the generic rows once (a Setting marks it, so deleting rows later is respected). */
export function ensure(db) {
    const sql = readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    for (const st of sql.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) db.exec(st)
    const hasSetting = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='Setting'").get()
    if (hasSetting && db.prepare('SELECT 1 FROM Setting WHERE key = ?').get(SEEDED)) return
    if (!db.prepare('SELECT 1 FROM RsiFlag LIMIT 1').get()) for (const f of SEED_FLAGS) save(db, f)
    if (hasSetting) db.prepare('INSERT OR REPLACE INTO Setting (key, value) VALUES (?, ?)').run(SEEDED, new Date().toISOString())
}

/** Rows by sort; the seed when the table is missing or empty. */
export function list(db) {
    try {
        const rows = db.prepare('SELECT id, match, domain, action, label, sort, updatedAt FROM RsiFlag ORDER BY sort, id').all()
        return rows.length ? rows.map((r) => ({ ...r })) : SEED_FLAGS
    } catch { return SEED_FLAGS }
}

/** Compile rows once for a run; a row whose regex does not compile is skipped (validate rejects it on save). */
export function compile(rows) {
    const out = []
    for (const r of rows) { try { out.push({ ...r, re: new RegExp(r.match) }) } catch { /* skip */ } }
    return out
}
const SEED_RULES = compile(SEED_FLAGS)

export const domainOf = (code, rules = SEED_RULES) => rules.find((r) => r.domain && r.re.test(code))?.domain ?? FALLBACK_DOMAIN
export const actionOf = (code, rules = SEED_RULES) => rules.find((r) => r.action && r.re.test(code))?.action ?? FALLBACK_ACTION

export function validate(f) {
    const errs = []
    if (!f.match) errs.push('match is required')
    else { try { new RegExp(f.match) } catch (e) { errs.push(`match: ${e.message}`) } }
    if (f.domain && !/^[a-z][a-z0-9_-]*$/.test(f.domain)) errs.push('domain: lower-case word')
    if (f.sort != null && !Number.isInteger(Number(f.sort))) errs.push('sort: integer')
    return errs
}

/** Insert or update by match; only the given fields change on update. */
export function save(db, f) {
    const errs = validate(f)
    if (errs.length) throw new Error(errs.join('; '))
    const t = new Date().toISOString()
    const old = db.prepare('SELECT * FROM RsiFlag WHERE match = ?').get(f.match)
    if (old) {
        db.prepare('UPDATE RsiFlag SET domain=?, action=?, label=?, sort=?, updatedAt=? WHERE id=?')
            .run(f.domain ?? old.domain, f.action ?? old.action, f.label ?? old.label, f.sort != null ? Number(f.sort) : old.sort, t, old.id)
        return 'updated'
    }
    const sort = f.sort != null ? Number(f.sort) : (db.prepare('SELECT MAX(sort) m FROM RsiFlag').get().m ?? 0) + 10
    db.prepare('INSERT INTO RsiFlag (match, domain, action, label, sort, updatedAt) VALUES (?,?,?,?,?,?)').run(f.match, f.domain ?? '', f.action ?? '', f.label ?? '', sort, t)
    return 'added'
}

export const remove = (db, match) => db.prepare('DELETE FROM RsiFlag WHERE match = ?').run(match).changes > 0
