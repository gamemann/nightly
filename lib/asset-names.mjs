// ASSETS: readable names for audit ids. The audit (a pack's own tool) builds an asset id from the model's path with "/" turned
// into "__", so a prop inside a map pack arrives as `maps__world__.stores__model-library__<set>__<piece>__<piece>`. The id stays the
// key (rows, findings and history refer to it); everything shown to a person comes from here. Pure, no I/O, used by the panel
// (src/server/assetsList.ts) and the CLI. Nothing in the database is rewritten: a "piece" is a rule, so it can be reversed by
// toggling a filter (`pieces=1` in the panel, `--pieces` in `nightly assets list`).

// Workspace-specific name rules (a legacy prefix to hide, a folder prefix to strip from labels, extra kit-part words) are data: the
// `assetNameRules` Setting (JSON), edited with `nightly set assetNameRules '<json>'` or in Settings. The defaults below are generic.
// Shape (all keys optional; a key replaces its default):
//   noise         [segment]          path segments that only say where a file sits (case-insensitive)
//   generic       [stem]             stems that name the container, not the model (the folder above is the name)
//   stripPrefix   regex source       removed from the start of a name (legacy prefixes), case-insensitive
//   hideSegment   regex source       path segments never shown as a group, case-insensitive
//   labelStrip    regex source       removed from a map or library label, case-insensitive
//   partPatterns  [LIKE pattern]     weaponId patterns (LIKE, `\` escapes) of weapon-kit parts that list on Models, not Entities
//   piecePacks    LIKE pattern       packs whose model-library / models folders hold map pieces
//   pieceDirs     [segment]          the folders inside such a pack that hold pieces
// State is module-level (like naming-rules.mjs): `loadNameRules(db)` in the CLI, `loadNameRulesAsync(read)` in the panel server.
export const NAME_DEFAULTS = Object.freeze({
    noise: ['maps', 'map', 'world', 'worlds', 'models', 'model-library', 'assets', 'art-src', 'src', 'base'],
    generic: ['model', 'scene', 'mesh', 'source', 'untitled', 'default'],
    stripPrefix: '', hideSegment: '', labelStrip: '',
    partPatterns: ['%\\_\\_bullet-%', '%\\_\\_clip-%', '%\\_\\_crate-%', '%\\_\\_scope-%', '%\\_\\_silencer-%', '%\\_\\_target-%', '%\\_\\_smoke', '%\\_magazine', '%\\_\\_ammo\\_\\_%'],
    piecePacks: '%-maps', pieceDirs: ['model-library', 'models'],
})
const sq = (s) => String(s).replace(/'/g, "''")
const likeRe = (p) => new RegExp('^' + p.replace(/\\(.)|([%_])|([.*+?^${}()|[\]\\])/g, (_, esc, w, meta) => esc ? esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : w ? (w === '%' ? '.*' : '.') : '\\' + meta) + '$', 's')
let R = null
/** The active rules (defaults merged with the setting). */
export const nameRules = () => R
/** SQL over `weaponId`: a weapon-kind row that is only a part of a weapon kit (magazine, clip, scope ...); these list on Models. */
export let PART_SQL = ''
/** SQL over `pack` and `weaponId`: a model inside a map pack's model library or a map's own model folder. */
export let PIECE_SQL = ''

/** Check rules text without applying it; returns the error message or ''. */
export function validateNameRules(input) {
    try { build(typeof input === 'string' ? JSON.parse(input || '{}') : input ?? {}); return '' } catch (e) { return e.message }
}
function build(o) {
    if (typeof o !== 'object' || Array.isArray(o) || o === null) throw new Error('assetNameRules: a JSON object')
    const unknown = Object.keys(o).filter((k) => !(k in NAME_DEFAULTS))
    if (unknown.length) throw new Error(`assetNameRules: unknown key ${unknown.join(', ')}`)
    const r = { ...NAME_DEFAULTS, ...o }
    for (const k of ['noise', 'generic', 'partPatterns', 'pieceDirs']) if (!Array.isArray(r[k]) || r[k].some((x) => typeof x !== 'string')) throw new Error(`assetNameRules.${k}: a list of strings`)
    const rx = (k) => { try { return r[k] ? new RegExp(r[k], 'i') : null } catch (e) { throw new Error(`assetNameRules.${k}: ${e.message}`) } }
    return { ...r, noiseSet: new Set(r.noise.map((x) => x.toLowerCase())), genericSet: new Set(r.generic.map((x) => x.toLowerCase())),
        stripRe: rx('stripPrefix'), hideRe: rx('hideSegment'), labelRe: rx('labelStrip'), piecePackRe: likeRe(r.piecePacks || '\x00') }
}
/** Apply rules (object or JSON text); throws on bad input and keeps the previous rules. */
export function setNameRules(input) {
    R = build(typeof input === 'string' ? JSON.parse(input || '{}') : input ?? {})
    PART_SQL = R.partPatterns.length ? `(${R.partPatterns.map((p) => `weaponId LIKE '${sq(p)}' ESCAPE '\\'`).join(' OR ')})` : '(0)'
    const dirs = R.pieceDirs.map((d) => `weaponId LIKE '%\\_\\_${sq(d.replace(/[\\%_]/g, '\\$&'))}\\_\\_%' ESCAPE '\\' OR weaponId LIKE '${sq(d.replace(/[\\%_]/g, '\\$&'))}\\_\\_%' ESCAPE '\\'`)
    PIECE_SQL = R.piecePacks && dirs.length ? `(pack LIKE '${sq(R.piecePacks)}' AND (${dirs.join(' OR ')}))` : '(0)'
}
setNameRules({})
/** Load from a node:sqlite handle (CLI). A missing row, table or a bad value keeps the current rules. */
export function loadNameRules(db) {
    try { const r = db.prepare("SELECT value FROM Setting WHERE key = 'assetNameRules'").get(); setNameRules(r?.value ?? '{}') } catch { /* keep */ }
}
let loadedAt = 0
/** Load for the panel server: `read()` resolves to the setting text (or null). Cached for `ttlMs`. */
export async function loadNameRulesAsync(read, ttlMs = 30_000) {
    if (Date.now() - loadedAt < ttlMs) return
    loadedAt = Date.now()
    try { setNameRules((await read()) ?? '{}') } catch { /* keep the previous rules */ }
}

export const idParts = (id) => String(id).split('__').filter(Boolean)

/** True for a model that lives inside a map pack's model library or a map's own model folder: a piece of a map, not an asset to
 *  judge on its own. Only packs named `*-maps` have pieces. */
export function isMapPiece(pack, id) {
    if (!R.piecePackRe.test(pack || '')) return false
    const p = idParts(id)
    return R.pieceDirs.some((d) => p.includes(d))
}
const trimStem = (s) => s.replace(/[_-][0-9a-f]{6}$/i, '')   // a trailing colour code (own_box_88x80x84_6a6a60)
const humanize = (s) => {
    const t = trimStem(R.stripRe ? s.replace(R.stripRe, '') : s).replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim()
    return t ? t[0].toUpperCase() + t.slice(1) : s
}

/** { name, group, groupKey, piece }: `groupKey` is the raw path segment (what an id contains between `__`), `group` its readable form; `name` the last meaningful segment humanized, `group` where it sits (its map, or its library set),
 *  `piece` whether it is a map piece (hidden from the list by default). The full id is always the tooltip. */
export function describe(pack, id) {
    let parts = idParts(id)
    while (parts.length > 1 && parts[parts.length - 1] === parts[parts.length - 2]) parts.pop()   // stem repeated by its own folder
    let i = parts.length - 1
    while (i > 0 && R.genericSet.has(parts[i].toLowerCase())) i--
    const raw = parts[i] ?? String(id)
    const context = parts.slice(0, i).map((s) => s.replace(/^\.+/, '')).filter((s) => s && !R.noiseSet.has(s.toLowerCase()) && !(R.stripRe?.test(s)) && !(R.hideRe?.test(s)))
    let group = ''
    const mi = parts.indexOf('maps')
    if (mi >= 0 && parts[mi + 1] && parts[mi + 1] !== 'world' && mi + 1 < i) group = parts[mi + 1]    // maps/<map>/worlds/...
    else group = context[context.length - 1] ?? ''
    if (!group && parts.includes('model-library')) group = 'model library'
    return { name: humanize(raw), group: group.replace(/[_]+/g, ' '), groupKey: group, piece: isMapPiece(pack, id) }
}

const humanLabel = (s) => { const t = (R.labelRe ? s.replace(R.labelRe, '') : s).replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim(); return t ? t[0].toUpperCase() + t.slice(1) : s }

/** Where a map piece belongs: `{ type: 'map', key, label }` for a piece of a playable level (`maps/<map>/...models...` or
 *  `<slices>/<prefix><map>/models/...`, labelStrip removes the prefix), `{ type: 'library', key, label }` for a shared model-library set
 *  (`.stores/model-library/<vendor>/<set>/...`), null for anything else. `key` is the raw id segment (what a `grp` filter
 *  matches between `__`), identical in every pack, so the same map or set in two packs is one place. */
export function placeOf(pack, id) {
    if (!isMapPiece(pack, id)) return null
    const parts = idParts(id)
    if (parts.includes('model-library')) {
        const d = describe(pack, id)
        return { type: 'library', key: d.groupKey || 'model-library', label: humanLabel(d.groupKey || 'model library') }
    }
    const mi = parts.indexOf('models')
    const key = parts[0] === 'maps' && parts[1] ? parts[1] : parts[mi - 1]
    return key ? { type: 'map', key, label: humanLabel(key) } : null
}
