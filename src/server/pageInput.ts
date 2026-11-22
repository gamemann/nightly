import { z } from 'zod'

/** The input every server-paged list query takes: the URL's page, size, sort, direction, search text and facet filters. */
export const pageIn = z.object({
    page: z.number().int().min(1).default(1), size: z.number().int().min(1).max(1000).default(100), sort: z.string().default(''), dir: z.enum(['asc', 'desc']).default('desc'),
    q: z.string().optional(), f: z.record(z.string(), z.string()).default({}),
})
export type PageIn = z.infer<typeof pageIn>
