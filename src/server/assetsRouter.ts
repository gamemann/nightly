import { z } from 'zod'
import { assetsCli } from './assetsServer'
import { procedure, router } from './trpc'
import { pageIn } from './pageInput'
import { offsetOf, paged } from '../lib/paging'

const name = z.string().regex(/^[\w.-]+$/)
const list = z.array(z.string())

/** Flags for `nightly assets source add|set`; absent fields are left out so `set` only changes what was sent. */
function sourceArgs(i: z.infer<typeof sourceInput>): string[] {
    const a: string[] = []
    if (i.type) a.push('--type', i.type)
    if (i.root) a.push('--root', i.root)
    if (i.repo) a.push('--repo', i.repo)
    if (i.enabled !== undefined) a.push(i.enabled ? '--enable' : '--disable')
    if (i.config) a.push('--config', JSON.stringify(i.config))
    return a
}
const sourceInput = z.object({
    name, type: z.enum(['pack', 'game']).optional(), root: z.string().optional(), repo: z.string().optional(), enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
})

export const assetsRouter = router({
    sources: procedure.input(pageIn).query(async ({ ctx, input }) => {
        const where = input.q ? { name: { contains: input.q } } : {}
        const total = await ctx.db.assetSource.count({ where })
        const dir = input.dir
        const orderBy = input.sort === 'name' ? [{ name: dir }] : [{ type: 'asc' as const }, { name: 'asc' as const }]
        return paged(await ctx.db.assetSource.findMany({ where, orderBy, skip: offsetOf(total, input), take: input.size }), total, input)
    }),
    kinds: procedure.input(pageIn).query(async ({ ctx, input }) => {
        const where = input.q ? { key: { contains: input.q } } : {}
        const total = await ctx.db.assetKind.count({ where })
        const orderBy = input.sort === 'key' ? [{ key: input.dir }] : [{ sort: 'asc' as const }, { key: 'asc' as const }]
        return paged(await ctx.db.assetKind.findMany({ where, orderBy, skip: offsetOf(total, input), take: input.size }), total, input)
    }),
    sourceAdd: procedure.input(sourceInput).mutation(({ input }) => assetsCli(['source', 'add', input.name, ...sourceArgs(input)])),
    sourceSet: procedure.input(sourceInput).mutation(({ input }) => assetsCli(['source', 'set', input.name, ...sourceArgs(input)])),
    sourceRm: procedure.input(z.object({ name, purge: z.boolean().optional() })).mutation(({ input }) => assetsCli(['source', 'rm', input.name, ...(input.purge ? ['--purge'] : [])])),
    /** Scan one source (or all enabled ones when no names are given). */
    scan: procedure.input(z.object({ names: list.optional() })).mutation(({ input }) => assetsCli(['scan', ...(input.names ?? [])])),
    kindSave: procedure.input(z.object({ key: name, label: z.string().optional(), sort: z.number().int().optional(), match: z.string().optional(), budget: z.record(z.string(), z.unknown()).optional() }))
        .mutation(({ input }) => assetsCli(['kind', 'set', input.key, ...(input.label ? ['--label', input.label] : []), ...(input.sort !== undefined ? ['--sort', String(input.sort)] : []),
            ...(input.match !== undefined ? ['--match', input.match] : []), ...(input.budget ? ['--budget', JSON.stringify(input.budget)] : [])])),
    kindRm: procedure.input(z.object({ key: name })).mutation(({ input }) => assetsCli(['kind', 'rm', input.key])),
})
