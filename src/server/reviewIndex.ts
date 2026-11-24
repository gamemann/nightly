import { statSync } from 'node:fs'
import { classify } from '../../lib/classify.mjs'
import { ensureNamingRules } from './namingRules'
import { load, jsonPath, type ReviewWeapon } from '../../lib/review.mjs'
import { offsetOf, paged, parsePage, type PageSpec } from '~/lib/paging'
import { filterReviews } from '../../lib/review-list.mjs'
import { reviewProgress, verdictParts, verdictsByDay } from '../../lib/charts.mjs'
import type { PrismaClient } from '../../generated/prisma/client'

/** Verdicts live in one review.json per review, not in the database, so listing, filtering and paging reviews needs an index of
 *  their counts. It is rebuilt per request from the review items (one query) plus a stat of each file; a file is only re-read when
 *  its mtime or size changed. The weapons of a review are paged by the `review.weapons` query when a card opens. */
type Counts = { total: number; good: number; wrong: number; todo: number }
type Info = { mtime: number; size: number; counts: Counts; events: { verdict: string; at: string }[] }
const cache = new Map<string, Info>()

function info(key: string): Info {
    let st: { mtimeMs: number; size: number } | null = null
    try { st = statSync(jsonPath(key)) } catch { /* no file yet: an empty review */ }
    const mtime = st?.mtimeMs ?? 0, size = st?.size ?? 0
    const hit = cache.get(key)
    if (hit && hit.mtime === mtime && hit.size === size) return hit
    const weapons = Object.values(load(key).weapons) as ReviewWeapon[]
    const v = weapons.map((w) => w.verdict)
    const events = weapons.flatMap((w) => [...(w.history ?? []), { verdict: w.verdict, at: w.at }]).filter((e) => e.at && (e.verdict === 'good' || e.verdict === 'wrong')).map((e) => ({ verdict: e.verdict, at: e.at }))
    const next = { mtime, size, events, counts: { total: v.length, good: v.filter((x) => x === 'good').length, wrong: v.filter((x) => x === 'wrong').length, todo: v.filter((x) => !x).length } }
    cache.set(key, next)
    return next
}

export const REVIEW_SPEC = { sorts: ['updated', 'created', 'title', 'game', 'entries', 'progress'], sort: 'updated', dir: 'desc', filters: ['game', 'state'] } as const satisfies PageSpec

export async function reviewPage(db: PrismaClient, sp: Record<string, string | string[] | undefined>) {
    await ensureNamingRules(db)
    const q = parsePage(sp, REVIEW_SPEC)
    const items = await db.item.findMany({ where: { kind: 'review' }, orderBy: { id: 'desc' }, select: { key: true, title: true, repos: true, createdAt: true, updatedAt: true } })
    const known = new Set<string>()
    const all = items.map((i) => ({ key: i.key, title: i.title, createdAt: i.createdAt.toISOString(), updatedAt: i.updatedAt.toISOString(), game: classify(i.repos, i.key, i.title, known) as string, ...info(i.key) }))
    const gameCount = new Map<string, number>()
    for (const r of all) gameCount.set(r.game, (gameCount.get(r.game) ?? 0) + 1)
    const shown = filterReviews(all, { q: q.q, game: q.f.game, state: q.f.state, sort: q.sort, dir: q.dir })
    const off = offsetOf(shown.length, q)
    const slice = shown.slice(off, off + q.size)
    const bodies = new Map((await db.item.findMany({ where: { key: { in: slice.map((r) => r.key) } }, select: { key: true, body: true } })).map((b) => [b.key, b.body]))
    const rows = slice.map(({ events: _e, mtime: _m, size: _s, ...r }) => ({ ...r, body: bodies.get(r.key) ?? '' }))
    const charts = {
        parts: verdictParts(all) as { key: string; label: string; value: number }[],
        progress: (reviewProgress(all) as { key: string; title: string; judged: number; good: number; wrong: number; todo: number; total: number }[]).slice(0, 8),
        days: verdictsByDay(all.map((r) => ({ weapons: Object.fromEntries(r.events.map((e, i) => [String(i), { history: [], verdict: e.verdict, at: e.at }])) })), { days: 30 }) as { key: string; good: number; wrong: number }[],
    }
    return { page: paged(rows, shown.length, q), games: [...gameCount].sort().map(([game, count]) => ({ game, count })), totalReviews: all.length, charts, query: q }
}
