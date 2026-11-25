// What each Assets tab lists, in ONE place: the row list, the tab counts and the kind-chip counts all build their SQL
// from these fragments, so a count can never promise rows the list does not show.
// Which kind lists on which tab is data: the `tab` column of its AssetKind row (entities | avatars | maps | '' = Models). A kind
// with no row is a plain model.
import { PART_SQL, PIECE_SQL } from './asset-names.mjs'

const tabKinds = (t) => `(SELECT key FROM AssetKind WHERE tab = '${t}')`
const ENT = tabKinds('entities'), AVA = tabKinds('avatars'), NOT_PLAIN = "(SELECT key FROM AssetKind WHERE tab != '')"

/** The predicate of a tab over AssetWeapon columns; maps and libraries are computed in JS and have none. Getters: the part rule
 *  follows the assetNameRules setting (lib/asset-names.mjs). */
export const TAB_SQL = {
    get entities() { return `hasModel = 1 AND kind IN ${ENT} AND NOT ${PART_SQL}` },
    avatars: `hasModel = 1 AND kind IN ${AVA}`,
    get models() { return `hasModel = 1 AND (kind NOT IN ${NOT_PLAIN} OR (kind IN ${ENT} AND ${PART_SQL}))` },
    textures: 'texCount > 0',
    animations: 'animCount > 0',
    sounds: 'soundCount > 0',
}

/** Identical files shipped by many games are ONE asset: same file hash and kind. Rows with no hash yet stay single. */
export const DEDUPE_KEY = "CASE WHEN fileHash != '' THEN fileHash || '|' || kind ELSE 'id' || id END"

/** Vendored copies (a game's byte-identical copy of a pack asset, assets-packrules.mjs) are listed and counted on their pack row only. */
export const NOT_VENDORED = "vendoredFrom = ''"

/** The table restricted to one canonical row (lowest id) per identical standalone asset. */
/** ` AND pack IN ('a','b')` for a project's packs (null = no restriction; an empty list matches nothing). */
export const packIn = (packs) => (packs ? ` AND pack IN (${packs.map((p) => `'${String(p).replace(/'/g, "''")}'`).join(',') || "''"})` : '')
export const uniqueFor = (packs) => `(SELECT * FROM AssetWeapon WHERE id IN (SELECT MIN(id) FROM AssetWeapon WHERE NOT ${PIECE_SQL} AND ${NOT_VENDORED}${packIn(packs)} GROUP BY ${DEDUPE_KEY})) AssetWeapon`
export const UNIQUE = uniqueFor(null)

/** Rows the list shows for a tab (optionally one kind chip): the list query's count. */
export const listCountSql = (tab, kind = '') =>
    `SELECT COUNT(*) c FROM (SELECT 1 FROM AssetWeapon WHERE NOT ${PIECE_SQL} AND ${NOT_VENDORED} AND ${TAB_SQL[tab]}${kind ? ` AND kind = '${kind}'` : ''} GROUP BY ${DEDUPE_KEY})`

/** The tab count and kind chip counts of the header: one SUM per tab over the unique rows. */
export const aggCountSql = (packs = null) =>
    `SELECT kind, ${Object.entries(TAB_SQL).map(([t, p]) => `SUM(${p}) ${t}`).join(', ')} FROM ${uniqueFor(packs)} GROUP BY kind`

/** Filters a tab understands. Everything else in the URL is ignored by the list query, never applied. */
const PLACE_ONLY = ['pieces', 'grp']
/** The URL filters that actually apply on a tab: place params only on Maps/Libraries, a kind only if it belongs to the tab.
 *  `kinds` = the AssetKind rows ({key, tab}). */
export function effectiveFilters(f, kinds = []) {
    const tab = f.tab || 'entities', out = { ...f }
    const place = tab === 'maps' || tab === 'libraries'
    if (!place) for (const k of PLACE_ONLY) delete out[k]
    else if (out.pieces !== '1') delete out.grp
    if (place && out.pieces !== '1') delete out.kind
    if (out.kind && (tab === 'entities' || tab === 'avatars' || tab === 'models') && !kindInTab(tab, out.kind, kinds)) delete out.kind
    return out
}

/** Does a kind belong to a tab's list (tabs without a kind rule take every kind). `kinds` = the AssetKind rows ({key, tab}). */
export function kindInTab(tab, kind, kinds = []) {
    const own = kinds.find((k) => k.key === kind)?.tab ?? ''
    if (tab === 'models') return own === ''
    if (tab === 'entities' || tab === 'avatars') return own === tab
    return true
}
