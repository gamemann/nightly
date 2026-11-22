/** Pure query builders for the server-paged Performance runs list and the Prompts list: the search clause, the sort whitelist
 *  and the default direction live here so lib tests cover them without the panel or a database. */

export const RUN_SORTS = ['ranAt', 'id', 'commit', 'label', 'platform', 'map']
const RUN_SEARCH = ['commit', 'label', 'name', 'map']

/** Prisma where/orderBy for a game's runs: the scope (platform, role, map, bots), a text search over commit, label, name and map,
 *  and a whitelisted sort (anything else falls back to newest first) with id as tie-break. */
export function runsQuery({ game, platform, role, map, bots, q = '', sort = '', dir = 'desc' }) {
    const needle = String(q ?? '').trim()
    const where = {
        game, ...(platform ? { platform } : {}), ...(role ? { role } : {}), ...(map !== undefined ? { map } : {}), ...(bots !== undefined ? { bots } : {}),
        ...(needle ? { OR: RUN_SEARCH.map((c) => ({ [c]: { contains: needle } })) } : {}),
    }
    const col = RUN_SORTS.includes(sort) ? sort : 'ranAt'
    return { where, orderBy: [{ [col]: dir === 'asc' ? 'asc' : 'desc' }, { id: 'desc' }] }
}

export const PROMPT_SORTS = ['name', 'updatedAt']

/** Prisma where/orderBy for the prompt or script list: kind, a search over name and text, a whitelisted sort. With no sort in the
 *  URL the list is by name ascending; an explicit sort takes the URL's direction. */
export function promptsQuery({ kind, q = '', sort = '', dir = 'asc' }) {
    const needle = String(q ?? '').trim()
    const col = PROMPT_SORTS.includes(sort) ? sort : 'name'
    return {
        where: { kind, ...(needle ? { OR: [{ name: { contains: needle } }, { body: { contains: needle } }] } : {}) },
        orderBy: [{ [col]: sort && dir === 'desc' ? 'desc' : 'asc' }, { id: 'asc' }],
    }
}

/** Filter, sort and slice a small in-memory list (the games overview, the ingest tokens) the same way the Prisma-backed lists do:
 *  `search` names the fields the text is matched against (case-insensitive), `sorts` maps each whitelisted sort key to a value getter,
 *  `filters` maps a facet key to a getter compared with ===. An unknown sort falls back to `fallback`; ties keep the input order. */
export function pageList(items, { q = '', sort = '', dir = 'asc', f = {}, page = 1, size = 100 }, { search = [], sorts = {}, filters = {}, fallback }) {
    const needle = String(q ?? '').trim().toLowerCase()
    let rows = items.filter((r) => (!needle || search.some((k) => String(r[k] ?? '').toLowerCase().includes(needle)))
        && Object.entries(f).every(([k, v]) => !v || !filters[k] || String(filters[k](r)) === v))
    const key = sorts[sort] ? sort : fallback
    const get = sorts[key]
    if (get) {
        const sign = dir === 'desc' ? -1 : 1
        rows = rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => {
            const x = get(a), y = get(b)
            const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''))
            return c * sign || i - j
        }).map(([r]) => r)
    }
    const total = rows.length
    const pages = Math.max(1, Math.ceil(total / size))
    const start = (Math.min(Math.max(1, page), pages) - 1) * size
    return { rows: rows.slice(start, start + size), total }
}
