// ASSETS: readable names for audit ids. The audit (a pack's own tool) builds an asset id from the model's path with "/" turned
// into "__", so a prop inside a map pack arrives as `maps__world__.stores__model-library__<set>__<piece>__<piece>`. The id stays the
// key (rows, findings and history refer to it); everything shown to a person comes from here. Pure, no I/O, used by the panel
// (src/server/assetsList.ts) and the CLI. Nothing in the database is rewritten: a "piece" is a rule, so it can be reversed by
// toggling a filter (`pieces=1` in the panel, `--pieces` in `nightly assets list`).

/** Path segments that only say where a file sits, never what it is. */
const NOISE = new Set(['maps', 'map', 'world', 'worlds', 'models', 'model-library', 'assets', 'art-src', 'src', 'base'])
/** A stem that names the container, not the model: the folder above it is the name. */
const GENERIC = new Set(['model', 'scene', 'mesh', 'source', 'untitled', 'default'])
/** Legacy name prefixes that must not be shown (naming rule); the underlying files are renamed in their own repositories. */
const LEGACY_PREFIX = /^(dm|dotmap)[_-]/i

export const idParts = (id) => String(id).split('__').filter(Boolean)

/** True for a model that lives inside a map pack's model library or a map's own model folder: a piece of a map, not an asset to
 *  judge on its own. Only packs named `*-maps` have pieces. */
export function isMapPiece(pack, id) {
    if (!/-maps$/.test(pack || '')) return false
    const p = idParts(id)
    return p.includes('model-library') || p.includes('models')
}
/** The same rule as SQL over the columns `pack` and `weaponId` (LIKE with `\` escapes). */
export const PIECE_SQL = "(pack LIKE '%-maps' AND (weaponId LIKE '%model-library%' OR weaponId LIKE '%\\_\\_models\\_\\_%' ESCAPE '\\'))"

const trimStem = (s) => s.replace(/[_-][0-9a-f]{6}$/i, '')   // a trailing colour code (own_box_88x80x84_6a6a60)
const humanize = (s) => {
    const t = trimStem(s.replace(LEGACY_PREFIX, '')).replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim()
    return t ? t[0].toUpperCase() + t.slice(1) : s
}

/** { name, group, groupKey, piece }: `groupKey` is the raw path segment (what an id contains between `__`), `group` its readable form; `name` the last meaningful segment humanized, `group` where it sits (its map, or its library set),
 *  `piece` whether it is a map piece (hidden from the list by default). The full id is always the tooltip. */
export function describe(pack, id) {
    let parts = idParts(id)
    while (parts.length > 1 && parts[parts.length - 1] === parts[parts.length - 2]) parts.pop()   // stem repeated by its own folder
    let i = parts.length - 1
    while (i > 0 && GENERIC.has(parts[i].toLowerCase())) i--
    const raw = parts[i] ?? String(id)
    const context = parts.slice(0, i).map((s) => s.replace(/^\.+/, '')).filter((s) => s && !NOISE.has(s.toLowerCase()) && !LEGACY_PREFIX.test(s) && !/^(dotmap)$/i.test(s))
    let group = ''
    const mi = parts.indexOf('maps')
    if (mi >= 0 && parts[mi + 1] && parts[mi + 1] !== 'world' && mi + 1 < i) group = parts[mi + 1]    // maps/<map>/worlds/...
    else group = context[context.length - 1] ?? ''
    if (!group && parts.includes('model-library')) group = 'model library'
    return { name: humanize(raw), group: group.replace(/[_]+/g, ' '), groupKey: group, piece: isMapPiece(pack, id) }
}
