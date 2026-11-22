/** Pure filter/sort helpers for the Reviews page. Verdicts live in review.json files, not the database, so the server
 *  filters in memory; these helpers hold that logic so it can be tested without the panel. */

/** Rows of one review's weapons (`{ id, w }`) matching a search (id or title) and a verdict (`todo` = none yet), sorted by id. */
export function filterWeapons(rows, { q = '', verdict = '', dir = 'asc' } = {}) {
    const needle = String(q ?? '').trim().toLowerCase()
    const sgn = dir === 'desc' ? -1 : 1
    return rows
        .filter((r) => (!needle || r.id.toLowerCase().includes(needle) || (r.w.title ?? '').toLowerCase().includes(needle)) && (!verdict || (verdict === 'todo' ? !r.w.verdict : r.w.verdict === verdict)))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * sgn)
}

const judged = (r) => (r.counts.total ? (r.counts.good + r.counts.wrong) / r.counts.total : 0)
const SORT = {
    updated: (r) => r.updatedAt, created: (r) => r.createdAt, title: (r) => r.title.toLowerCase(), game: (r) => r.game,
    entries: (r) => r.counts.total, progress: judged,
}
export const REVIEW_SORTS = Object.keys(SORT)

/** Reviews (`{ key, title, game, counts, createdAt, updatedAt }`) matching a search (title or key), a game and a verdict state
 *  (has at least one entry in that state), sorted with the key as tie-break. */
export function filterReviews(all, { q = '', game = '', state = '', sort = 'updated', dir = 'desc' } = {}) {
    const needle = String(q ?? '').trim().toLowerCase()
    const f = SORT[sort] ?? SORT.updated
    const sgn = dir === 'asc' ? 1 : -1
    return all
        .filter((r) => (!game || r.game === game) && (!state || r.counts[state] > 0) && (!needle || r.title.toLowerCase().includes(needle) || r.key.toLowerCase().includes(needle)))
        .sort((a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0) * sgn || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
