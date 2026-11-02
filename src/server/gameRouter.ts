import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { OPEN_STATUSES } from '~/lib/constants'
import { OTHER, gameOf, knownGames } from '~/lib/games'
import { ATTACH_DIR } from './media'
import { modelSibling } from './models'
import { procedure, router } from './trpc'

const OPEN = new Set<string>(OPEN_STATUSES)

export const gameRouter = router({
    /** Every game with its item and QA counts, derived from item repos and QA run games. */
    list: procedure.query(async ({ ctx }) => {
        const [items, qa] = await Promise.all([
            ctx.db.item.findMany({ select: { repos: true, status: true, key: true, title: true } }),
            ctx.db.qaRun.findMany({ select: { game: true, ok: true, ranAt: true }, orderBy: { ranAt: 'desc' }, take: 600 }),
        ])
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

    /** One game's items, runs (those that wrote notes on its items), screenshots with models, reviews and QA runs. */
    get: procedure.input(z.object({ slug: z.string().regex(/^[\w.-]+$/) })).query(async ({ ctx, input }) => {
        const all = await ctx.db.item.findMany({ select: { id: true, key: true, title: true, kind: true, status: true, priority: true, repos: true, updatedAt: true }, orderBy: [{ updatedAt: 'desc' }] })
        const qaAll = await ctx.db.qaRun.findMany({ orderBy: { ranAt: 'desc' }, take: 600 })
        const known = knownGames([...all.map((i) => i.repos), ...qaAll.map((q) => q.game)])
        const items = all.filter((i) => gameOf(i.repos, known, i.key, i.title) === input.slug)
        const ids = items.map((i) => i.id)
        const notes = ids.length ? await ctx.db.note.findMany({ where: { itemId: { in: ids }, runId: { not: null } }, select: { runId: true }, distinct: ['runId'] }) : []
        const runs = await ctx.db.run.findMany({
            where: { id: { in: notes.map((n) => n.runId!) } }, orderBy: { startedAt: 'desc' }, take: 40,
            select: { id: true, startedAt: true, status: true, summary: true, minutes: true, costUsd: true, schedule: { select: { name: true } } },
        })
        const shots: { item: string; file: string; note: string; at: string; model: string | null }[] = []
        for (const it of items) {
            const dir = path.join(ATTACH_DIR, it.key.replace(/[^\w.-]/g, '_'))
            try {
                const idx = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8')) as { file: string; note: string; at: string }[]
                const files = await readdir(dir)
                for (const a of idx) shots.push({ item: it.key, file: a.file, note: a.note, at: a.at, model: modelSibling(files, a.file) })
            } catch { /* no attachments */ }
        }
        shots.sort((a, b) => b.at.localeCompare(a.at))
        const qa = qaAll.filter((q) => gameOf(q.game, known) === input.slug).slice(0, 60).map((r) => ({
            id: r.id, kind: r.kind, game: r.game, ranAt: r.ranAt, ok: r.ok, total: r.total, failedCount: r.failedCount, commit: r.commit,
            failures: (JSON.parse(r.failures) as { name: string; reasons: string[] }[]).slice(0, 20),
            images: JSON.parse(r.images) as { file: string; note: string }[],
        }))
        return { slug: input.slug, items, runs, shots: shots.slice(0, 120), reviews: items.filter((i) => i.kind === 'review'), qa }
    }),
})
