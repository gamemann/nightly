import { z } from 'zod'
import { load, type ReviewWeapon } from '../../lib/review.mjs'
import { offsetOf, paged } from '~/lib/paging'
import { pageIn } from './pageInput'
import { procedure, router } from './trpc'

export const reviewRouter = router({
    /** One review's weapons (entries), searched by id or title, filtered by verdict, paged; only the requested page ships its media lists. */
    weapons: procedure.input(pageIn.extend({ key: z.string().min(1).max(200) })).query(({ input }) => {
        const all = Object.entries(load(input.key).weapons as Record<string, ReviewWeapon>).map(([id, w]) => ({ id, w }))
        const q = input.q?.trim().toLowerCase()
        const v = input.f.verdict
        const rows = all
            .filter((r) => (!q || r.id.toLowerCase().includes(q) || (r.w.title ?? '').toLowerCase().includes(q)) && (!v || (v === 'todo' ? !r.w.verdict : r.w.verdict === v)))
            .sort((a, b) => (a.id < b.id ? -1 : 1) * (input.dir === 'desc' ? -1 : 1))
        const off = offsetOf(rows.length, input)
        return paged(rows.slice(off, off + input.size), rows.length, input)
    }),
})
