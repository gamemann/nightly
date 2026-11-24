import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { OPEN_STATUSES } from '~/lib/constants'
import { offsetOf, paged } from '~/lib/paging'
import { pageIn } from './pageInput'
import { OTHER, gameOf, knownGames } from '~/lib/games'
import { ensureNamingRules } from './namingRules'
import { ATTACH_DIR } from './media'
import { modelSibling } from './models'
import { procedure, router } from './trpc'

import type { PrismaClient } from '../../generated/prisma/client'

const slugIn = z.object({ slug: z.string().regex(/^[\w.-]+$/) })
type Db = PrismaClient
const OPEN = new Set<string>(OPEN_STATUSES)

export const gameRouter = router({
    /** Every game with its item and QA counts, derived from item repos and QA run games. */
    list: procedure.query(async ({ ctx }) => {
        const [items, qa] = await Promise.all([
            ctx.db.item.findMany({ select: { repos: true, status: true, key: true, title: true } }),
            ctx.db.qaRun.findMany({ select: { game: true, ok: true, ranAt: true }, orderBy: { ranAt: 'desc' }, take: 600 }),
        ])
        await ensureNamingRules(ctx.db)
        const known = knownGames([...items.map((i) => i.repos), ...qa.map((q) => q.game)])
        const m = new Map<string, { slug: string; open: number; total: number; qa: number; qaFailing: boolean }>()
        const get = (s: string) => { let g = m.get(s); if (!g) m.set(s, g = { slug: s, open: 0, total: 0, qa: 0, qaFailing: false }); return g }
        for (const k of known) get(k)
        for (const i of items) { const g = get(gameOf(i.repos, known, i.key, i.title)); g.total++; if (OPEN.has(i.status)) g.open++ }
        const seen = new Set<string>()
        for (const q of qa) {
            const g = get(gameOf(q.game, known)); g.qa++
            const key = `${g.slug}`
            if (!seen.has(key)) { seen.add(key); g.qaFailing = !q.ok }
        }
        return [...m.values()].filter((g) => g.slug !== OTHER || g.total > 0).sort((a, b) => b.open - a.open || a.slug.localeCompare(b.slug))
    }),

    /** Counts for one game's tabs; the rows come from the paged `items`, `runs`, `media` and `qa` queries. */
    get: procedure.input(slugIn).query(async ({ ctx, input }) => {
        const m = await members(ctx.db, input.slug)
        const [runs, shots, qa] = await Promise.all([
            m.ids.length ? runIdsOf(ctx.db, m.ids).then((r) => r.length) : 0,
            shotsOf(m.items).then((s) => s.length),
            m.games.length ? ctx.db.qaRun.count({ where: { game: { in: m.games } } }) : 0,
        ])
        return { slug: input.slug, items: m.items.length, reviews: m.items.filter((i) => i.kind === 'review').length, runs, media: shots, qa }
    }),

    /** The game's items (or only its reviews), searched, filtered by status, sorted and paged. */
    items: procedure.input(pageIn.extend({ slug: slugIn.shape.slug, reviews: z.boolean().default(false) })).query(async ({ ctx, input }) => {
        const m = await members(ctx.db, input.slug)
        let rows = input.reviews ? m.items.filter((i) => i.kind === 'review') : m.items
        const statuses = [...new Set(rows.map((i) => i.status))].sort()
        const q = input.q?.trim().toLowerCase()
        if (q) rows = rows.filter((i) => i.title.toLowerCase().includes(q) || i.key.toLowerCase().includes(q))
        if (input.f.status) rows = rows.filter((i) => i.status === input.f.status)
        const key = (['updatedAt', 'title', 'status', 'key'] as const).find((k) => k === input.sort) ?? 'updatedAt'
        const sign = input.dir === 'asc' ? 1 : -1
        rows = [...rows].sort((a, b) => sign * String(a[key]).localeCompare(String(b[key])) || a.id - b.id)
        const off = offsetOf(rows.length, input)
        return { page: paged(rows.slice(off, off + input.size).map(({ id, key, title, status, kind, updatedAt }) => ({ id, key, title, status, kind, updatedAt })), rows.length, input), statuses }
    }),

    /** Runs that wrote a note on the game's items, newest first, paged in SQL. */
    runs: procedure.input(pageIn.extend({ slug: slugIn.shape.slug })).query(async ({ ctx, input }) => {
        const m = await members(ctx.db, input.slug)
        const ids = m.ids.length ? await runIdsOf(ctx.db, m.ids) : []
        const w: object[] = [{ id: { in: ids } }]
        if (input.f.status) w.push({ status: input.f.status })
        const q = input.q?.trim()
        if (q) w.push({ summary: { contains: q } })
        const where = { AND: w }
        const total = await ctx.db.run.count({ where })
        const key = (['startedAt', 'id', 'status'] as const).find((k) => k === input.sort) ?? 'startedAt'
        const rows = await ctx.db.run.findMany({
            where, orderBy: [{ [key]: input.dir }, { id: 'desc' }], skip: offsetOf(total, input), take: input.size,
            select: { id: true, startedAt: true, status: true, summary: true, minutes: true, costUsd: true, schedule: { select: { name: true } } },
        })
        const statuses = (await ctx.db.run.findMany({ where: { id: { in: ids } }, select: { status: true }, distinct: ['status'] })).map((r) => r.status).sort()
        return { page: paged(rows, total, input), statuses }
    }),

    /** Screenshots (with 3D model siblings) on the game's items, newest first, paged. */
    media: procedure.input(pageIn.extend({ slug: slugIn.shape.slug })).query(async ({ ctx, input }) => {
        const m = await members(ctx.db, input.slug)
        let shots = await shotsOf(m.items)
        const q = input.q?.trim().toLowerCase()
        if (q) shots = shots.filter((s) => s.item.toLowerCase().includes(q) || s.note.toLowerCase().includes(q) || s.file.toLowerCase().includes(q))
        if (input.f.kind === '3d') shots = shots.filter((s) => s.model)
        if (input.dir === 'asc') shots = [...shots].reverse()
        const off = offsetOf(shots.length, input)
        return { page: paged(shots.slice(off, off + input.size), shots.length, input) }
    }),

    /** The game's QA runs, newest first, paged in SQL (no 600-run cut-off). */
    qa: procedure.input(pageIn.extend({ slug: slugIn.shape.slug })).query(async ({ ctx, input }) => {
        const m = await members(ctx.db, input.slug)
        const w: object[] = [{ game: { in: m.games } }]
        if (input.f.state === 'ok') w.push({ ok: true })
        if (input.f.state === 'failing') w.push({ ok: false })
        const q = input.q?.trim()
        if (q) w.push({ OR: [{ kind: { contains: q } }, { commit: { contains: q } }] })
        const where = { AND: w }
        const total = m.games.length ? await ctx.db.qaRun.count({ where }) : 0
        const rows = total ? await ctx.db.qaRun.findMany({ where, orderBy: [{ ranAt: input.dir }, { id: 'desc' }], skip: offsetOf(total, input), take: input.size }) : []
        return {
            page: paged(rows.map((r) => ({
                id: r.id, kind: r.kind, game: r.game, ranAt: r.ranAt, ok: r.ok, total: r.total, failedCount: r.failedCount, commit: r.commit,
                failures: (JSON.parse(r.failures) as { name: string; reasons: string[] }[]).slice(0, 20),
                images: JSON.parse(r.images) as { file: string; note: string }[],
            })), total, input),
        }
    }),
})


/** The game's items and the QA `game` values that classify to it. Classification is JS-only (lib/games), so this reads the light columns of every item and the distinct QA games. */
async function members(db: Db, slug: string) {
    await ensureNamingRules(db)
    const [links, qaGames] = await Promise.all([
        // every item linked to this project (ItemProject, many-to-many: an item with several projects is listed under each)
        db.itemProject.findMany({ where: { project: { slug } }, select: { item: { select: { id: true, key: true, title: true, kind: true, status: true, repos: true, updatedAt: true } } } }),
        db.qaRun.findMany({ select: { game: true }, distinct: ['game'] }),
    ])
    const items = links.map((l) => l.item).sort((x, y) => y.updatedAt.getTime() - x.updatedAt.getTime())
    const known = new Set<string>([slug, ...qaGames.map((q) => q.game)])
    return { items, ids: items.map((i) => i.id), games: qaGames.map((q) => q.game).filter((g) => g === slug || gameOf(g, known) === slug) }
}

async function runIdsOf(db: Db, ids: number[]) {
    const notes = await db.note.findMany({ where: { itemId: { in: ids }, runId: { not: null } }, select: { runId: true }, distinct: ['runId'] })
    return notes.map((n) => n.runId!)
}

async function shotsOf(items: { key: string }[]) {
    const shots: { item: string; file: string; note: string; at: string; model: string | null }[] = []
    for (const it of items) {
        const dir = path.join(ATTACH_DIR, it.key.replace(/[^\w.-]/g, '_'))
        try {
            const idx = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8')) as { file: string; note: string; at: string }[]
            const files = await readdir(dir)
            for (const a of idx) shots.push({ item: it.key, file: a.file, note: a.note, at: a.at, model: modelSibling(files, a.file) })
        } catch { /* no attachments */ }
    }
    return shots.sort((a, b) => b.at.localeCompare(a.at))
}
