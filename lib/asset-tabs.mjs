// What each Assets tab lists, in ONE place: the row list, the tab counts and the kind-chip counts all build their SQL
// from these fragments, so a count can never promise rows the list does not show.
import { AVATAR_KINDS, ENTITY_KINDS, PIECE_SQL } from './asset-names.mjs'

const list = (ks) => ks.map((k) => `'${k}'`).join(',')
const ENT = list(ENTITY_KINDS), AVA = list(AVATAR_KINDS), NOT_PLAIN = list([...ENTITY_KINDS, ...AVATAR_KINDS, 'level'])
/** The kinds each tab owns (null: every kind). */
export const TAB_KINDS = { entities: ENTITY_KINDS, avatars: AVATAR_KINDS }

/** The predicate of a tab over AssetWeapon columns; maps and libraries are computed in JS and have none. */
export const TAB_SQL = {
    entities: `hasModel = 1 AND kind IN (${ENT})`,
    avatars: `hasModel = 1 AND kind IN (${AVA})`,
    models: `hasModel = 1 AND kind NOT IN (${NOT_PLAIN})`,
    textures: 'texCount > 0',
    animations: 'animCount > 0',
    sounds: 'soundCount > 0',
}

/** Identical files shipped by many games are ONE asset: same file hash and kind. Rows with no hash yet stay single. */
export const DEDUPE_KEY = "CASE WHEN fileHash != '' THEN fileHash || '|' || kind ELSE 'id' || id END"

/** The table restricted to one canonical row (lowest id) per identical standalone asset. */
export const UNIQUE = `(SELECT * FROM AssetWeapon WHERE id IN (SELECT MIN(id) FROM AssetWeapon WHERE NOT ${PIECE_SQL} GROUP BY ${DEDUPE_KEY})) AssetWeapon`

/** Rows the list shows for a tab (optionally one kind chip): the list query's count. */
export const listCountSql = (tab, kind = '') =>
    `SELECT COUNT(*) c FROM (SELECT 1 FROM AssetWeapon WHERE NOT ${PIECE_SQL} AND ${TAB_SQL[tab]}${kind ? ` AND kind = '${kind}'` : ''} GROUP BY ${DEDUPE_KEY})`

/** The tab count and kind chip counts of the header: one SUM per tab over the unique rows. */
export const aggCountSql = () =>
    `SELECT kind, ${Object.entries(TAB_SQL).map(([t, p]) => `SUM(${p}) ${t}`).join(', ')} FROM ${UNIQUE} GROUP BY kind`

/** Filters a tab understands. Everything else in the URL is ignored by the list query, never applied. */
const PLACE_ONLY = ['pieces', 'grp']
/** The URL filters that actually apply on a tab: place params only on Maps/Libraries, a kind only if it belongs to the tab. */
export function effectiveFilters(f) {
    const tab = f.tab || 'entities', out = { ...f }
    const place = tab === 'maps' || tab === 'libraries'
    if (!place) for (const k of PLACE_ONLY) delete out[k]
    else if (out.pieces !== '1') delete out.grp
    if (place && out.pieces !== '1') delete out.kind
    if (out.kind && (tab === 'entities' || tab === 'avatars' || tab === 'models') && !kindInTab(tab, out.kind)) delete out.kind
    return out
}

/** Does a kind belong to a tab's list (tabs without a kind rule take every kind). */
export function kindInTab(tab, kind) {
    if (tab === 'models') return ![...ENTITY_KINDS, ...AVATAR_KINDS, 'level'].includes(kind)
    return TAB_KINDS[tab] ? TAB_KINDS[tab].includes(kind) : true
}
