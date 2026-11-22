/** Server-side paging shared by every list page. The state lives in URL search params (page, size, sort, dir, q and one param per
 *  facet filter), so links, back and reload keep it; the server turns it into limit/offset/order/where. */
export const PAGE_SIZES = [100, 500, 1000] as const
export const DEFAULT_SIZE = 100

export type SortDir = 'asc' | 'desc'
export type PageQuery = { page: number; size: number; sort: string; dir: SortDir; q: string; f: Record<string, string> }
export type Paged<T> = { rows: T[]; total: number; page: number; size: number; pages: number; from: number; to: number }
export type PageSpec = { sorts: readonly string[]; sort: string; dir?: SortDir; filters?: readonly string[] }
type Params = URLSearchParams | Record<string, string | string[] | undefined>

const get = (p: Params, k: string) => {
    const v = p instanceof URLSearchParams ? p.get(k) : p[k]
    return (Array.isArray(v) ? v[0] : v) ?? ''
}

/** Reads and validates the paging params; anything unknown falls back to the default (sorts and filters are whitelists). */
export function parsePage(p: Params, spec: PageSpec): PageQuery {
    const size = Number(get(p, 'size'))
    const sort = get(p, 'sort')
    const d = get(p, 'dir')
    const f: Record<string, string> = {}
    for (const k of spec.filters ?? []) { const v = get(p, k); if (v) f[k] = v }
    return {
        page: Math.max(1, Math.floor(Number(get(p, 'page'))) || 1),
        size: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_SIZE,
        sort: spec.sorts.includes(sort) ? sort : spec.sort,
        dir: d === 'asc' || d === 'desc' ? d : spec.dir ?? 'asc',
        q: get(p, 'q').trim().slice(0, 200),
        f,
    }
}

/** Wraps one page of rows with the numbers the footer shows; the page is clamped to the last one that exists. */
export function paged<T>(rows: T[], total: number, q: Pick<PageQuery, 'page' | 'size'>): Paged<T> {
    const pages = Math.max(1, Math.ceil(total / q.size))
    const page = Math.min(q.page, pages)
    return { rows, total, page, size: q.size, pages, from: total ? (page - 1) * q.size + 1 : 0, to: Math.min(total, (page - 1) * q.size + rows.length) }
}

/** The offset for a (possibly past-the-end) page, given the total. */
export const offsetOf = (total: number, q: Pick<PageQuery, 'page' | 'size'>) =>
    (Math.min(q.page, Math.max(1, Math.ceil(total / q.size))) - 1) * q.size

/** Escapes LIKE wildcards so a search for 100% or a_b is literal. */
export const likeEsc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
