import { feedRouter } from './feedRouter'
import { execFile } from 'node:child_process'
import { suggestRepos } from '../../lib/classify.mjs'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { Prisma, PrismaClient } from '../../generated/prisma/client'
import { cronError, nextFires } from '../../lib/cron.mjs'
import { OWNER, CADENCES, KINDS, LIVE_MINUTES, OPEN_STATUSES, STATUSES, isDue, slugify } from '~/lib/constants'
import { likeEsc, offsetOf, paged } from '~/lib/paging'
import { pageIn } from './pageInput'
import { AUTH_KEYS, PRIVATE_SETTINGS, forgetAuth, hashPassword, newSecret } from './auth'
import { ATTACH_DIR, MEDIA_DIR, MEDIA_EXT } from './media'
import { assetsRouter } from './assetsRouter'
import { gameRouter } from './gameRouter'
import { perfRouter } from './perfRouter'
import { usageRouter } from './usageRouter'
import { reviewRouter } from './reviewRouter'
import { modelSibling } from './models'
import { procedure, router } from './trpc'

const run = promisify(execFile)
/** Starting and stopping runs goes through the CLI, so the runner is a child of `nightly exec`
 *  (detached) and never of this server: restarting the panel cannot kill a run. */
async function cli(...args: string[]) {
    try {
        const { stdout } = await run(path.join(process.cwd(), 'bin', 'nightly'), args, { timeout: 15_000, env: { ...process.env } })
        return stdout.trim()
    } catch (e) {
        const err = e as { stderr?: string; message: string }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (err.stderr || err.message).replace(/^nightly: /, '').trim() })
    }
}

type Tx = Prisma.TransactionClient | PrismaClient

export const VIEWS = ['queue', 'in_progress', 'review', 'blocked', 'issues', 'checks', 'done', 'all'] as const
export type View = (typeof VIEWS)[number]
export const RUN_SORTS = ['started', 'status', 'turns', 'minutes', 'cost', 'trigger', 'id'] as const
export const ITEM_SORTS = ['key', 'title', 'kind', 'status', 'priority', 'updated', 'done'] as const

function whereFor(view: View): Prisma.ItemWhereInput {
    switch (view) {
        case 'queue': return { status: 'queue', kind: { not: 'check' } }
        case 'in_progress': return { status: 'in_progress' }
        case 'review': return { status: 'review' }
        case 'blocked': return { status: 'blocked' }
        case 'issues': return { kind: 'issue', status: { in: [...OPEN_STATUSES] } }
        case 'checks': return { kind: 'check' }
        case 'done': return { status: { in: ['done', 'wontfix'] } }
        case 'all': return {}
    }
}

/** Items sharing a priority list with `it`: same status, and checks apart from everything else. */
async function siblings(tx: Tx, status: string, isCheck: boolean) {
    return tx.item.findMany({
        where: { status, kind: isCheck ? 'check' : { not: 'check' } },
        orderBy: [{ priority: 'asc' }, { id: 'asc' }],
        select: { id: true },
    })
}

async function renumber(tx: Tx, ids: number[]) {
    for (const [i, id] of ids.entries()) await tx.item.update({ where: { id }, data: { priority: (i + 1) * 10 } })
}

async function place(tx: Tx, id: number, where: 'top' | 'bottom' | 'up' | 'down') {
    const it = await tx.item.findUniqueOrThrow({ where: { id } })
    const ids = (await siblings(tx, it.status, it.kind === 'check')).map((r) => r.id)
    const from = ids.indexOf(id)
    if (from !== -1) ids.splice(from, 1)
    const at = where === 'top' ? 0 : where === 'bottom' ? ids.length
        : where === 'up' ? Math.max(0, from - 1) : Math.min(ids.length, from + 1)
    ids.splice(at, 0, id)
    await renumber(tx, ids)
}

async function uniqueKey(tx: Tx, base: string) {
    const has = async (k: string) => !!(await tx.item.findUnique({ where: { key: k }, select: { id: true } }))
    if (/-\d+$/.test(base) && !(await has(base))) return base
    for (let n = 1; ; n++) if (!(await has(`${base}-${n}`))) return `${base}-${n}`
}

const keyInput = z.object({ key: z.string().min(1) })

const itemRouter = router({
    /** One page of items: view, kind/status filters, search, sort and limit/offset all in the database. */
    list: procedure
        .input(z.object({
            view: z.enum(VIEWS), q: z.string().optional(), page: z.number().int().min(1).default(1), size: z.number().int().min(1).max(1000).default(100),
            sort: z.enum(ITEM_SORTS).optional(), dir: z.enum(['asc', 'desc']).optional(), kind: z.string().optional(), status: z.string().optional(),
        }))
        .query(async ({ ctx, input }) => {
            const q = input.q?.trim()
            const where: Prisma.ItemWhereInput = {
                ...(q ? {} : whereFor(input.view)),
                ...(q ? { OR: [{ title: { contains: q } }, { key: { contains: q } }, { body: { contains: q } }, { repos: { contains: q } }] } : {}),
                ...((KINDS as readonly string[]).includes(input.kind ?? '') ? { kind: input.kind } : {}),
                ...((STATUSES as readonly string[]).includes(input.status ?? '') ? { status: input.status } : {}),
            }
            const done = input.view === 'done'
            const sort = input.sort ?? (done ? 'done' : 'priority')
            const dir = input.dir ?? (!input.sort && done ? 'desc' : 'asc')
            const col = { key: 'key', title: 'title', kind: 'kind', status: 'status', priority: 'priority', updated: 'updatedAt', done: 'completedAt' }[sort] as string
            const total = await ctx.db.item.count({ where })
            const items = await ctx.db.item.findMany({
                where,
                orderBy: [{ [col]: dir }, { id: dir }] as Prisma.ItemOrderByWithRelationInput[],
                skip: offsetOf(total, input), take: input.size,
                select: {
                    id: true, key: true, title: true, kind: true, status: true, priority: true, repos: true, cadence: true,
                    lastRunAt: true, completedAt: true, updatedAt: true, addedBy: true, _count: { select: { notes: true } },
                },
            })
            return { ...paged(items.map((i) => ({ ...i, due: isDue(i) })), total, input), orderable: !q && !input.sort && !input.kind && !input.status && ['queue', 'in_progress', 'review', 'blocked', 'checks'].includes(input.view) }
        }),

    counts: procedure.query(async ({ ctx }) => {
        const entries = await Promise.all(
            VIEWS.filter((v) => v !== 'all').map(async (v) => [v, await ctx.db.item.count({ where: whereFor(v) })] as const),
        )
        const checks = await ctx.db.item.findMany({ where: { kind: 'check' }, select: { kind: true, status: true, cadence: true, lastRunAt: true } })
        return { ...Object.fromEntries(entries), dueChecks: checks.filter((c) => isDue(c)).length } as Record<View | 'dueChecks', number>
    }),

    get: procedure.input(keyInput).query(async ({ ctx, input }) => {
        const it = await ctx.db.item.findUnique({
            where: { key: input.key },
            include: { _count: { select: { notes: true } } },
        })
        if (!it) throw new TRPCError({ code: 'NOT_FOUND', message: `no item ${input.key}` })
        let attachments: { file: string; note: string; by: string; at: string; bytes: number }[] = []
        try { attachments = JSON.parse(await readFile(path.join(ATTACH_DIR, it.key.replace(/[^\w.-]/g, '_'), 'index.json'), 'utf8')) } catch { /* none */ }
        return { ...it, due: isDue(it), attachments: await withModels(it.key, attachments) }
    }),

    create: procedure
        .input(z.object({
            title: z.string().trim().min(1),
            key: z.string().trim().regex(/^[\w.-]+$/).optional(),
            kind: z.enum(KINDS).default('task'),
            status: z.enum(STATUSES).default('queue'),
            repos: z.string().default(''),
            body: z.string().default(''),
            doneWhen: z.string().optional(),
            cadence: z.enum(CADENCES).optional(),
            position: z.enum(['top', 'bottom']).default('bottom'),
        }))
        .mutation(async ({ ctx, input }) => ctx.db.$transaction(async (tx) => {
            if (input.key && (await tx.item.findUnique({ where: { key: input.key } }))) {
                throw new TRPCError({ code: 'CONFLICT', message: `key ${input.key} exists` })
            }
            const key = input.key || (await uniqueKey(tx, slugify(input.title)))
            const closed = input.status === 'done' || input.status === 'wontfix'
            const it = await tx.item.create({
                data: {
                    key, title: input.title, kind: input.kind, status: input.status, body: input.body,
                    repos: input.repos.split(',').map((s) => s.trim()).filter(Boolean).join(', ') || suggestRepos(key, input.title),
                    doneWhen: input.doneWhen || null, addedBy: OWNER,
                    cadence: input.kind === 'check' ? (input.cadence ?? 'nightly') : null,
                    priority: 1_000_000, completedAt: closed ? new Date() : null,
                },
            })
            await place(tx, it.id, input.position)
            return it
        })),

    update: procedure
        .input(z.object({
            key: z.string(),
            patch: z.object({
                title: z.string().trim().min(1).optional(),
                body: z.string().optional(),
                kind: z.enum(KINDS).optional(),
                status: z.enum(STATUSES).optional(),
                repos: z.string().optional(),
                doneWhen: z.string().nullable().optional(),
                cadence: z.enum(CADENCES).nullable().optional(),
                newKey: z.string().trim().regex(/^[\w.-]+$/).optional(),
            }),
        }))
        .mutation(async ({ ctx, input }) => ctx.db.$transaction(async (tx) => {
            const it = await tx.item.findUnique({ where: { key: input.key } })
            if (!it) throw new TRPCError({ code: 'NOT_FOUND' })
            const { newKey, status, repos, ...rest } = input.patch
            const data: Prisma.ItemUpdateInput = { ...rest }
            if (newKey && newKey !== it.key) {
                if (await tx.item.findUnique({ where: { key: newKey } })) throw new TRPCError({ code: 'CONFLICT', message: `key ${newKey} exists` })
                data.key = newKey
            }
            if (repos !== undefined) data.repos = repos.split(',').map((s) => s.trim()).filter(Boolean).join(', ')
            const statusChanged = status !== undefined && status !== it.status
            if (statusChanged) {
                data.status = status
                data.completedAt = status === 'done' || status === 'wontfix' ? new Date() : null
            }
            const out = await tx.item.update({ where: { id: it.id }, data })
            if (statusChanged || (rest.kind && rest.kind !== it.kind)) await place(tx, it.id, out.status === 'queue' ? 'bottom' : 'top')
            return out
        })),

    move: procedure
        .input(z.object({ key: z.string(), to: z.enum(['up', 'down', 'top', 'bottom']) }))
        .mutation(async ({ ctx, input }) => ctx.db.$transaction(async (tx) => {
            const it = await tx.item.findUniqueOrThrow({ where: { key: input.key } })
            await place(tx, it.id, input.to)
        })),

    checked: procedure.input(keyInput.extend({ note: z.string().optional() })).mutation(async ({ ctx, input }) => {
        const it = await ctx.db.item.update({ where: { key: input.key }, data: { lastRunAt: new Date() } })
        if (input.note?.trim()) await ctx.db.note.create({ data: { itemId: it.id, author: OWNER, body: input.note.trim() } })
        return it
    }),

    delete: procedure.input(keyInput).mutation(({ ctx, input }) => ctx.db.item.delete({ where: { key: input.key } })),
})

const noteRouter = router({
    /** One item's notes, newest page first (each page is returned oldest-first as a timeline); search and author filter in SQL. */
    list: procedure.input(pageIn.extend({ key: z.string() })).query(async ({ ctx, input }) => {
        const w: object[] = [{ item: { key: input.key } }]
        if (input.f.author) w.push({ author: input.f.author })
        const q = input.q?.trim()
        if (q) w.push({ OR: [{ body: { contains: q } }, { author: { contains: q } }] })
        const where = { AND: w }
        const total = await ctx.db.note.count({ where })
        const rows = await ctx.db.note.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: offsetOf(total, input), take: input.size, include: { run: { select: { id: true, startedAt: true } } } })
        const authors = (await ctx.db.note.groupBy({ by: ['author'], where: { item: { key: input.key } } })).map((r) => r.author).sort()
        return { page: paged(rows.reverse(), total, input), facets: { author: authors } }
    }),
    add: procedure
        .input(z.object({ key: z.string(), body: z.string().trim().min(1), author: z.string().default(OWNER) }))
        .mutation(async ({ ctx, input }) => {
            const it = await ctx.db.item.findUniqueOrThrow({ where: { key: input.key } })
            const [n] = await ctx.db.$transaction([
                ctx.db.note.create({ data: { itemId: it.id, author: input.author, body: input.body } }),
                ctx.db.item.update({ where: { id: it.id }, data: { updatedAt: new Date() } }),
            ])
            return n
        }),
    delete: procedure.input(z.object({ id: z.number() })).mutation(({ ctx, input }) => ctx.db.note.delete({ where: { id: input.id } })),
})

const runRouter = router({
    /** One page of runs (sort, status/trigger/schedule filters and search in the database) plus SQL aggregates for the charts over every run. */
    list: procedure.input(z.object({
        q: z.string().optional(), scheduleId: z.number().optional(), page: z.number().int().min(1).default(1), size: z.number().int().min(1).max(1000).default(100),
        sort: z.enum(RUN_SORTS).optional(), dir: z.enum(['asc', 'desc']).optional(), status: z.string().optional(), trigger: z.string().optional(),
    }).optional()).query(async ({ ctx, input }) => {
        const i = input ?? { page: 1, size: 100 }
        const q = i.q?.trim()
        const where: Prisma.RunWhereInput = {
            ...(q ? { OR: [{ summary: { contains: q } }, { report: { contains: q } }, { log: { contains: q } }] } : {}),
            ...(i.scheduleId ? { scheduleId: i.scheduleId } : {}),
            ...(i.status ? { status: i.status } : {}),
            ...(i.trigger ? { trigger: i.trigger } : {}),
        }
        const col = { started: 'startedAt', status: 'status', turns: 'turns', minutes: 'minutes', cost: 'costUsd', trigger: 'trigger', id: 'id' }[i.sort ?? 'started'] as string
        const dir = i.dir ?? 'desc'
        const total = await ctx.db.run.count({ where })
        const rows = await ctx.db.run.findMany({
            where,
            orderBy: [{ [col]: dir }, { id: 'desc' }] as Prisma.RunOrderByWithRelationInput[],
            skip: offsetOf(total, i), take: i.size,
            select: {
                id: true, startedAt: true, finishedAt: true, status: true, summary: true, turns: true, minutes: true, costUsd: true, trigger: true,
                schedule: { select: { id: true, name: true } }, _count: { select: { notes: true } },
            },
        })
        const [statuses, triggers] = await Promise.all([ctx.db.run.groupBy({ by: ['status'], _count: { _all: true } }), ctx.db.run.groupBy({ by: ['trigger'], _count: { _all: true } })])
        return { page: paged(rows, total, i), statuses: statuses.map((x) => x.status), triggers: triggers.map((x) => x.trigger) }
    }),
    /** Chart inputs, bounded in SQL and slim (no report or log): runs of the last `days` days, the newest 30 with a duration or cost,
     *  and the newest 20 runs of every schedule with its all-time run count. Never the whole table. */
    chart: procedure.input(z.object({ days: z.number().int().min(1).max(365).default(30) }).optional()).query(async ({ ctx, input }) => {
        const days = input?.days ?? 30
        const slim = { id: true, startedAt: true, status: true, minutes: true, costUsd: true } as const
        const [recent, latest, totals] = await Promise.all([
            ctx.db.run.findMany({ where: { startedAt: { gte: new Date(Date.now() - (days + 1) * 86_400_000) } }, select: slim, orderBy: { startedAt: 'desc' }, take: 5000 }),
            ctx.db.run.findMany({ select: slim, orderBy: { startedAt: 'desc' }, take: 60 }),
            ctx.db.run.groupBy({ by: ['scheduleId'], where: { scheduleId: { not: null } }, _count: { _all: true } }),
        ])
        const scheds = await ctx.db.schedule.findMany({ select: { id: true, name: true } })
        const perSched = await Promise.all(scheds.map(async (sc) => ({
            schedule: sc,
            runs: await ctx.db.run.findMany({ where: { scheduleId: sc.id }, select: slim, orderBy: { startedAt: 'desc' }, take: 20 }),
            total: totals.find((t) => t.scheduleId === sc.id)?._count._all ?? 0,
        })))
        const byId = new Map<number, (typeof recent)[number]>()
        for (const r of [...recent, ...latest]) byId.set(r.id, r)
        return { runs: [...byId.values()], perSched }
    }),

    get: procedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
        const r = await ctx.db.run.findUnique({
            where: { id: input.id },
            include: {
                schedule: { select: { id: true, name: true, prompt: true } },
            },
        })
        if (!r) throw new TRPCError({ code: 'NOT_FOUND' })
        return r
    }),
    /** The notes a run left on items, a page at a time: search (note text, item key or title), item-status filter, sort by id (oldest first by default) or item key. */
    notes: procedure.input(pageIn.extend({ id: z.number() })).query(async ({ ctx, input }) => {
        const w: object[] = [{ runId: input.id }]
        const q = input.q?.trim()
        if (q) w.push({ OR: [{ body: { contains: q } }, { item: { key: { contains: q } } }, { item: { title: { contains: q } } }] })
        if (input.f.status) w.push({ item: { status: input.f.status } })
        const where = { AND: w }
        const total = await ctx.db.note.count({ where })
        const dir = input.sort ? input.dir : 'asc'
        const orderBy = input.sort === 'item' ? [{ item: { key: dir } }, { id: 'asc' as const }] : [{ id: dir }]
        const [rows, statuses] = await Promise.all([
            ctx.db.note.findMany({ where, orderBy, skip: offsetOf(total, input), take: input.size, include: { item: { select: { key: true, title: true, status: true } } } }),
            ctx.db.item.groupBy({ by: ['status'], where: { notes: { some: { runId: input.id } } } }),
        ])
        return { page: paged(rows, total, input), facets: { status: statuses.map((x) => x.status).sort() } }
    }),
    /** Frames under the media dir for one local day (YYYY-MM-DD), as paths for /media/. */
    media: procedure.input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).query(async ({ input }) => {
        const out: { path: string; size: number }[] = []
        const walk = async (dir: string, rel: string) => {
            let ents
            try { ents = await readdir(dir, { withFileTypes: true }) } catch { return }
            for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
                if (out.length >= 400) return
                if (e.isDirectory()) await walk(path.join(dir, e.name), `${rel}/${e.name}`)
                else if (MEDIA_EXT[path.extname(e.name).toLowerCase()]) out.push({ path: `${rel}/${e.name}`, size: (await stat(path.join(dir, e.name))).size })
            }
        }
        await walk(path.join(MEDIA_DIR, input.date), input.date)
        return out
    }),
    stop: procedure.input(z.object({ id: z.number() })).mutation(({ input }) => cli('run', 'stop', String(input.id))),
})

const scheduleInput = z.object({
    name: z.string().trim().min(1).max(60),
    cron: z.string().trim().refine((c) => !cronError(c), (c) => ({ message: cronError(c) ?? 'bad cron' })),
    enabled: z.boolean(),
    prompt: z.string().trim().regex(/^[\w.-]+$/, 'a prompt name'),
    instructions: z.string(),
    maxTurns: z.number().int().min(1).max(5000),
    allowOverlap: z.boolean(),
})

const scheduleRouter = router({
    list: procedure.input(pageIn).query(async ({ ctx, input }) => {
        const where = { ...(input.q ? { name: { contains: input.q } } : {}), ...(input.f.enabled ? { enabled: input.f.enabled === 'on' } : {}) }
        const key = ['name', 'cron', 'enabled'].includes(input.sort) ? input.sort : 'id'
        const total = await ctx.db.schedule.count({ where })
        const rows = await ctx.db.schedule.findMany({
            where, orderBy: { [key]: key === 'id' ? 'asc' : input.dir }, skip: offsetOf(total, input), take: input.size,
            include: { runs: { orderBy: { startedAt: 'desc' }, take: 1, select: { id: true, status: true, startedAt: true, summary: true } } },
        })
        const now = new Date()
        return paged(rows.map(({ runs, ...s }) => {
            const error = cronError(s.cron)
            return { ...s, error, next: error ? [] : nextFires(s.cron, now, 3), lastRun: runs[0] ?? null }
        }), total, input)
    }),
    /** Slim list of enabled schedules for the next-fires timeline (not a page: the timeline spans all of them). */
    fires: procedure.query(async ({ ctx }) => {
        const now = new Date()
        return (await ctx.db.schedule.findMany({ where: { enabled: true }, orderBy: { id: 'asc' }, select: { id: true, name: true, cron: true } }))
            .map((s) => ({ id: s.id, name: s.name, next: cronError(s.cron) ? [] : nextFires(s.cron, now, 3) }))
    }),
    /** Whether a prompt name is a script (job) rather than a prompt. */
    kindOf: procedure.input(z.object({ name: z.string() })).query(async ({ ctx, input }) =>
        (await ctx.db.prompt.findFirst({ where: { name: input.name }, select: { kind: true } }))?.kind ?? null),
    /** Next fire times for an expression being typed (or why it is invalid). */
    preview: procedure.input(z.object({ cron: z.string() })).query(({ input }) => {
        const error = cronError(input.cron)
        return { error, next: error ? [] : nextFires(input.cron, new Date(), 3) }
    }),
    /** The prompts a schedule can start with, matching a typed search, at most one page (the picker is a search box, not a full list). */
    prompts: procedure.input(z.object({ q: z.string().optional(), size: z.number().int().min(1).max(1000).default(100) }).optional()).query(async ({ ctx, input }) => {
        const q = input?.q?.trim()
        return (await ctx.db.prompt.findMany({ where: { kind: 'prompt', ...(q ? { name: { contains: q } } : {}) }, orderBy: { name: 'asc' }, take: input?.size ?? 100, select: { name: true } })).map((p) => p.name)
    }),
    create: procedure.input(scheduleInput.partial().extend({ name: z.string().trim().min(1) })).mutation(({ ctx, input }) =>
        ctx.db.schedule.create({ data: { cron: '0 7 * * *', ...input } })),
    update: procedure.input(z.object({ id: z.number(), patch: scheduleInput.partial() })).mutation(({ ctx, input }) =>
        ctx.db.schedule.update({ where: { id: input.id }, data: input.patch })),
    delete: procedure.input(z.object({ id: z.number() })).mutation(({ ctx, input }) => ctx.db.schedule.delete({ where: { id: input.id } })),
    /** Run now: ignores the doRun switch (that pauses the clock, not you). Returns the new run's id. */
    start: procedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
        const out = JSON.parse(await cli('start', String(input.id), '--json')) as { id: number; status: string }
        return out
    }),
    running: procedure.query(({ ctx }) =>
        ctx.db.run.findMany({ where: { status: 'running' }, orderBy: { startedAt: 'desc' }, select: { id: true, startedAt: true, schedule: { select: { name: true } } } })),
})

const promptName = z.string().trim().regex(/^[\w.-]{1,80}$/, 'letters, digits, . _ - (e.g. deploy.md)')

const promptRouter = router({
    /** The sidebar list of prompts or jobs: search (name, body), sort and paging in SQL. */
    page: procedure.input(pageIn.extend({ kind: z.enum(['prompt', 'script']) })).query(async ({ ctx, input }) => {
        const q = input.q?.trim()
        const where = { kind: input.kind, ...(q ? { OR: [{ name: { contains: q } }, { body: { contains: q } }] } : {}) }
        const sort = ['name', 'updatedAt'].includes(input.sort) ? input.sort : 'name'
        const dir = input.sort ? input.dir : 'asc'
        const total = await ctx.db.prompt.count({ where })
        const [rows, schedules] = await Promise.all([
            ctx.db.prompt.findMany({ where, orderBy: [{ [sort]: dir }, { id: 'asc' }], skip: offsetOf(total, input), take: input.size, select: { id: true, name: true, kind: true, body: true, updatedAt: true } }),
            ctx.db.schedule.findMany({ select: { name: true, prompt: true } }),
        ])
        return paged(rows.map(({ body, ...p }) => ({ ...p, size: body.length, codeLike: body.startsWith('#!'), usedBy: schedules.filter((x) => x.prompt === p.name).map((x) => x.name) })), total, input)
    }),
    /** A job script's linked schedules and the most recent run of any of them. */
    job: procedure.input(z.object({ name: z.string() })).query(async ({ ctx, input }) => {
        const schedules = await ctx.db.schedule.findMany({ where: { prompt: input.name }, select: { id: true, name: true } })
        const lastRun = schedules.length
            ? await ctx.db.run.findFirst({ where: { scheduleId: { in: schedules.map((s) => s.id) } }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, startedAt: true } })
            : null
        return { schedules, lastRun }
    }),
    get: procedure.input(z.object({ name: z.string() })).query(async ({ ctx, input }) => {
        const p = await ctx.db.prompt.findUnique({
            where: { name: input.name },
            include: { versions: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, author: true, note: true, createdAt: true } } },
        })
        if (!p) throw new TRPCError({ code: 'NOT_FOUND', message: `no prompt ${input.name}` })
        return p
    }),
    version: procedure.input(z.object({ id: z.number() })).query(({ ctx, input }) => ctx.db.promptVersion.findUniqueOrThrow({ where: { id: input.id } })),
    /** Save a body. `base` is the text the edit started from: if the stored body has moved on
     *  since (the nightly run or another tab saved), refuse rather than overwrite it. */
    save: procedure
        .input(z.object({ name: promptName, body: z.string(), base: z.string().optional(), note: z.string().max(300).default(''), kind: z.enum(['prompt', 'script']).optional() }))
        .mutation(({ ctx, input }) => ctx.db.$transaction(async (tx) => {
            const cur = await tx.prompt.findUnique({ where: { name: input.name } })
            if (cur && input.base !== undefined && cur.body !== input.base) {
                throw new TRPCError({ code: 'CONFLICT', message: `${input.name} was changed elsewhere since you opened it` })
            }
            if (cur && cur.body === input.body && (!input.kind || input.kind === cur.kind)) return cur
            const p = cur
                ? await tx.prompt.update({ where: { id: cur.id }, data: { body: input.body, kind: input.kind ?? cur.kind } })
                : await tx.prompt.create({ data: { name: input.name, body: input.body, kind: input.kind ?? (input.name.endsWith('.md') ? 'prompt' : 'script') } })
            if (!cur || cur.body !== input.body) await tx.promptVersion.create({ data: { promptId: p.id, body: input.body, author: OWNER, note: input.note } })
            return p
        })),
    delete: procedure.input(z.object({ name: z.string() })).mutation(async ({ ctx, input }) => {
        const used = await ctx.db.schedule.findMany({ where: { prompt: input.name }, select: { name: true } })
        if (used.length) throw new TRPCError({ code: 'CONFLICT', message: `used by schedule ${used.map((s) => `"${s.name}"`).join(', ')}` })
        await ctx.db.prompt.delete({ where: { name: input.name } })
    }),
})

/** Adds the sibling model file name (or null) to each attachment of one item. */
export async function withModels<T extends { file: string }>(item: string, rows: T[]): Promise<(T & { model: string | null })[]> {
    const files = await readdir(path.join(ATTACH_DIR, item.replace(/[^\w.-]/g, '_'))).catch(() => [] as string[])
    return rows.map((r) => ({ ...r, model: modelSibling(files, r.file) }))
}

const liveSince = () => new Date(Date.now() - LIVE_MINUTES * 60_000)

const attachmentRouter = router({
    /** Every item attachment, newest first, filtered by item and by item/note text, paged. */
    list: procedure
        .input(z.object({ item: z.string().optional(), q: z.string().optional(), limit: z.number().int().min(1).max(200).default(48), offset: z.number().int().min(0).default(0) }))
        .query(async ({ input }) => {
            type Row = { item: string; file: string; note: string; by: string; at: string; bytes: number }
            const all: Row[] = []
            for (const d of await readdir(ATTACH_DIR).catch(() => [] as string[])) {
                try {
                    const idx = JSON.parse(await readFile(path.join(ATTACH_DIR, d, 'index.json'), 'utf8')) as Omit<Row, 'item'>[]
                    for (const a of idx) all.push({ ...a, item: d })
                } catch { /* not an attachment dir */ }
            }
            const items = [...new Set(all.map((a) => a.item))].sort()
            const q = input.q?.trim().toLowerCase()
            const rows = all
                .filter((a) => (!input.item || a.item === input.item) && (!q || `${a.item} ${a.note}`.toLowerCase().includes(q)))
                .sort((a, b) => b.at.localeCompare(a.at))
            const page = rows.slice(input.offset, input.offset + input.limit)
            const withModel = (await Promise.all([...new Set(page.map((a) => a.item))].map(async (k) => withModels(k, page.filter((a) => a.item === k))))).flat()
            return { total: rows.length, items, rows: page.map((a) => withModel.find((m) => m.item === a.item && m.file === a.file)!) }
        }),
})

export type PerfMetric = { value: number; baseline?: number; budget: number; cap: number; noise_pct?: number; status: string }
export type PerfSummary = { gpu?: string; tolerance?: number; resolution?: string; dirty?: boolean; metrics?: Record<string, Record<string, PerfMetric>> }

export const QA_SORTS = ['ranAt', 'game', 'kind', 'ok', 'failed', 'total', 'commit'] as const

const qaRouter = router({
    /** Every QA run as a paged table: sort, game/kind/result filters and search (game, commit) in the database. */
    history: procedure.input(z.object({
        page: z.number().int().min(1).default(1), size: z.number().int().min(1).max(1000).default(100), sort: z.enum(QA_SORTS).default('ranAt'), dir: z.enum(['asc', 'desc']).default('desc'),
        q: z.string().optional(), game: z.string().optional(), kind: z.string().optional(), result: z.enum(['pass', 'fail']).optional(),
    })).query(async ({ ctx, input }) => {
        const q = input.q?.trim()
        const where: Prisma.QaRunWhereInput = {
            ...(q ? { OR: [{ game: { contains: q } }, { commit: { contains: q } }, { kind: { contains: q } }, { failures: { contains: q } }] } : {}),
            ...(input.game ? { game: input.game } : {}), ...(input.kind ? { kind: input.kind } : {}),
            ...(input.result ? { ok: input.result === 'pass' } : {}),
        }
        const col = { ranAt: 'ranAt', game: 'game', kind: 'kind', ok: 'ok', failed: 'failedCount', total: 'total', commit: 'commit' }[input.sort]
        const total = await ctx.db.qaRun.count({ where })
        const rows = await ctx.db.qaRun.findMany({
            where, orderBy: [{ [col]: input.dir }, { id: 'desc' }] as Prisma.QaRunOrderByWithRelationInput[], skip: offsetOf(total, input), take: input.size,
            select: { id: true, game: true, kind: true, commit: true, ranAt: true, ok: true, total: true, failedCount: true },
        })
        const [games, kinds] = await Promise.all([ctx.db.qaRun.groupBy({ by: ['game'] }), ctx.db.qaRun.groupBy({ by: ['kind'] })])
        return { page: paged(rows, total, input), games: games.map((g) => g.game).sort(), kinds: kinds.map((k) => k.kind).sort() }
    }),
    /** Every (game, kind) pair, paged; each carries its newest runs (the card shows the last 30 as a trend). Search (game, kind),
     *  game/kind/latest-result filters and sort (game, kind, latest run) happen in SQL. */
    cards: procedure.input(pageIn.extend({ runs: z.number().int().min(1).max(200).default(30) })).query(async ({ ctx, input }) => {
        const w: string[] = []
        const args: unknown[] = []
        const q = input.q?.trim()
        if (q) { w.push(`(game LIKE ? ESCAPE '\\' OR kind LIKE ? ESCAPE '\\')`); args.push(`%${likeEsc(q)}%`, `%${likeEsc(q)}%`) }
        if (input.f.game) { w.push('game = ?'); args.push(input.f.game) }
        if (input.f.kind) { w.push('kind = ?'); args.push(input.f.kind) }
        const having = input.f.result === 'pass' ? 'HAVING latestOk = 1' : input.f.result === 'fail' ? 'HAVING latestOk = 0' : ''
        const inner = `SELECT game, kind, MAX(ranAt) latest, (SELECT r2.ok FROM QaRun r2 WHERE r2.game = r.game AND r2.kind = r.kind ORDER BY r2.ranAt DESC, r2.id DESC LIMIT 1) latestOk
            FROM QaRun r ${w.length ? `WHERE ${w.join(' AND ')}` : ''} GROUP BY game, kind ${having}`
        const total = Number((await ctx.db.$queryRawUnsafe<{ n: number | bigint }[]>(`SELECT COUNT(*) n FROM (${inner})`, ...args))[0]?.n ?? 0)
        const col = { game: 'game', kind: 'kind', ranAt: 'latest' }[input.sort as 'game'] ?? 'game'
        const dir = input.sort ? (input.dir === 'desc' ? 'DESC' : 'ASC') : 'ASC'
        const slice = await ctx.db.$queryRawUnsafe<{ game: string; kind: string }[]>(
            `SELECT game, kind FROM (${inner}) ORDER BY ${col} ${dir}, game ASC, kind ASC LIMIT ? OFFSET ?`, ...args, input.size, offsetOf(total, input))
        const [games, kinds] = await Promise.all([ctx.db.qaRun.groupBy({ by: ['game'] }), ctx.db.qaRun.groupBy({ by: ['kind'] })])
        const cards = await Promise.all(slice.map(async (k) => {
            const rows = await ctx.db.qaRun.findMany({ where: { game: k.game, kind: k.kind }, orderBy: { ranAt: 'desc' }, take: input.runs })
            return {
                game: k.game, kind: k.kind,
                runs: rows.map((r) => ({
                    id: r.id, kind: r.kind, game: r.game, commit: r.commit, ranAt: r.ranAt, ok: r.ok, total: r.total, failedCount: r.failedCount,
                    failures: JSON.parse(r.failures) as { name: string; repro: string; note: string; reasons: string[] }[],
                    images: JSON.parse(r.images) as { file: string; note: string }[],
                    // only perf runs carry per-metric numbers worth shipping to the page
                    summary: r.kind === 'perf' ? (JSON.parse(r.summary) as PerfSummary) : null,
                })),
            }
        }))
        return { page: paged(cards, total, input), facets: { game: games.map((g) => g.game).sort(), kind: kinds.map((k) => k.kind).sort() } }
    }),
    /** Slim rows (no failures, images or summaries) for the last N days: what the two overview charts count. */
    overview: procedure.input(z.object({ days: z.number().int().min(1).max(365).default(30) })).query(({ ctx, input }) =>
        ctx.db.qaRun.findMany({ where: { ranAt: { gte: new Date(Date.now() - (input.days + 1) * 86_400_000) } }, orderBy: { ranAt: 'desc' }, select: { id: true, game: true, kind: true, ranAt: true, ok: true } })),
})

const CLAIMS_PER_AGENT = 3
const CLAIM_SORTS = ['createdAt', 'scope', 'agent'] as const

const agentRouter = router({
    board: procedure.query(async ({ ctx }) => {
        const [agents, recent, claimRows, counts] = await Promise.all([
            ctx.db.agent.findMany({ where: { endedAt: null }, orderBy: { startedAt: 'asc' } }),
            ctx.db.agent.findMany({
                where: { endedAt: { gte: new Date(Date.now() - 24 * 3600_000) } }, orderBy: { endedAt: 'desc' }, take: 20,
            }),
            // The first CLAIMS_PER_AGENT open claims of each agent (a window function); the full list is the paged `claims` query.
            ctx.db.$queryRawUnsafe<{ id: number; agentId: number; scope: string; note: string; createdAt: string | number }[]>(
                `SELECT id, agentId, scope, note, createdAt FROM (SELECT id, agentId, scope, note, createdAt, ROW_NUMBER() OVER (PARTITION BY agentId ORDER BY createdAt, id) rn FROM Claim WHERE releasedAt IS NULL) WHERE rn <= ? ORDER BY createdAt, id`, CLAIMS_PER_AGENT),
            ctx.db.claim.groupBy({ by: ['agentId'], where: { releasedAt: null }, _count: { _all: true } }),
        ])
        const claims = claimRows.map((c) => ({ ...c, createdAt: new Date(c.createdAt) }))
        const since = liveSince()
        // Silent past agentLeftHours (default 12) counts as left even before `nightly agent sweep` retires the row.
        const leftHrs = Number((await ctx.db.setting.findUnique({ where: { key: 'agentLeftHours' } }))?.value) || 12
        const gone = new Date(Date.now() - leftHrs * 3600_000)
        return {
            leftHours: leftHrs,
            live: agents.filter((a) => a.lastSeenAt >= since),
            quiet: agents.filter((a) => a.lastSeenAt < since && a.lastSeenAt >= gone),
            ended: recent,
            claims,
            claimCounts: Object.fromEntries(counts.map((c) => [c.agentId, c._count._all])) as Record<number, number>,
        }
    }),
    /** Every open claim, paged: search scope/note/agent, filter by agent or staleness (an agent that left or went quiet), sort in SQL. */
    claims: procedure.input(pageIn).query(async ({ ctx, input }) => {
        const since = liveSince()
        const w: object[] = [{ releasedAt: null }]
        if (input.f.agent) w.push({ agent: { name: input.f.agent } })
        if (input.f.state === 'stale') w.push({ OR: [{ agent: { endedAt: { not: null } } }, { agent: { lastSeenAt: { lt: since } } }] })
        if (input.f.state === 'live') w.push({ agent: { endedAt: null, lastSeenAt: { gte: since } } })
        const q = input.q?.trim()
        if (q) w.push({ OR: [{ scope: { contains: q } }, { note: { contains: q } }, { agent: { name: { contains: q } } }] })
        const where = { AND: w }
        const total = await ctx.db.claim.count({ where })
        const key = (CLAIM_SORTS as readonly string[]).includes(input.sort) ? input.sort : 'createdAt'
        const orderBy = key === 'agent' ? [{ agent: { name: input.dir } }, { id: 'asc' as const }] : [{ [key]: input.dir }, { id: 'asc' as const }]
        const rows = await ctx.db.claim.findMany({ where, orderBy, skip: offsetOf(total, input), take: input.size, include: { agent: { select: { name: true, kind: true, lastSeenAt: true, endedAt: true } } } })
        const names = (await ctx.db.agent.findMany({ where: { endedAt: null, claims: { some: { releasedAt: null } } }, select: { name: true }, distinct: ['name'] })).map((a) => a.name).sort()
        return { page: paged(rows.map((c) => ({ id: c.id, scope: c.scope, note: c.note, createdAt: c.createdAt, agent: c.agent.name, stale: !!c.agent.endedAt || c.agent.lastSeenAt < since })), total, input), facets: { agent: names } }
    }),
    /** The message log, newest page first (each page is returned oldest-first for reading); search, author filter and hide-board are SQL. */
    messages: procedure.input(pageIn).query(async ({ ctx, input }) => {
        const w: object[] = []
        if (input.f.author) w.push({ author: input.f.author })
        if (input.f.hide) w.push({ author: { not: 'board' } })
        const q = input.q?.trim()
        if (q) w.push({ OR: [{ body: { contains: q } }, { author: { contains: q } }, { to: { contains: q } }] })
        const where = w.length ? { AND: w } : {}
        const total = await ctx.db.message.count({ where })
        const rows = await ctx.db.message.findMany({ where, orderBy: { id: 'desc' }, skip: offsetOf(total, input), take: input.size })
        const authors = (await ctx.db.message.groupBy({ by: ['author'] })).map((r) => r.author).sort()
        return { page: paged(rows.reverse(), total, input), facets: { author: authors } }
    }),
    liveCount: procedure.query(({ ctx }) => ctx.db.agent.count({ where: { endedAt: null, lastSeenAt: { gte: liveSince() } } })),
    post: procedure.input(z.object({ body: z.string().trim().min(1).max(4000), to: z.string().trim().optional() })).mutation(({ ctx, input }) =>
        ctx.db.message.create({ data: { author: OWNER, body: input.body, to: input.to || null } })),
    release: procedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
        const c = await ctx.db.claim.update({ where: { id: input.id }, data: { releasedAt: new Date() }, include: { agent: true } })
        await ctx.db.message.create({ data: { author: 'board', body: `${OWNER} released ${c.agent.name}'s claim on ${c.scope}` } })
    }),
    /** End a session that went away without leaving (its claims go with it). */
    end: procedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
        const t = new Date()
        const a = await ctx.db.agent.update({ where: { id: input.id }, data: { endedAt: t } })
        await ctx.db.claim.updateMany({ where: { agentId: a.id, releasedAt: null }, data: { releasedAt: t } })
        await ctx.db.message.create({ data: { author: 'board', body: `${OWNER} ended ${a.name}` } })
    }),
})

const settingRouter = router({
    all: procedure.query(async ({ ctx }) => {
        const rows = await ctx.db.setting.findMany()
        return Object.fromEntries(rows.filter((r) => !PRIVATE_SETTINGS.has(r.key)).map((r) => [r.key, r.value])) as Record<string, string>
    }),
    set: procedure
        .input(z.object({ key: z.string().min(1).refine((k) => !(AUTH_KEYS as readonly string[]).includes(k), 'login settings are changed under auth'), value: z.string() }))
        .mutation(({ ctx, input }) => ctx.db.setting.upsert({ where: { key: input.key }, create: input, update: { value: input.value } })),
})

const setSetting = (tx: Tx, key: string, value: string) => tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } })

const authRouter = router({
    status: procedure.query(async ({ ctx }) => {
        const rows = await ctx.db.setting.findMany({ where: { key: { in: [...AUTH_KEYS] } } })
        const v = Object.fromEntries(rows.map((r) => [r.key, r.value]))
        return { enabled: v.authEnabled === 'true' && !!v.authHash, user: v.authUser ?? '', hasPassword: !!v.authHash }
    }),
    /** Change the login. While it is on, only a signed-in browser gets here (the proxy). Turning it on
     *  needs a password, new or already set. Changing user or password signs every browser out. */
    configure: procedure
        .input(z.object({
            enabled: z.boolean(),
            user: z.string().trim().max(60).regex(/^[^\s:]*$/, 'no spaces or colons'),
            password: z.string().min(8, 'at least 8 characters').max(200).optional(),
        }))
        .mutation(({ ctx, input }) => ctx.db.$transaction(async (tx) => {
            const hash = (await tx.setting.findUnique({ where: { key: 'authHash' } }))?.value
            if (input.enabled && !hash && !input.password) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Set a password to turn the login on.' })
            if (input.password) await setSetting(tx, 'authHash', hashPassword(input.password))
            if (!(await tx.setting.findUnique({ where: { key: 'authSecret' } }))) await setSetting(tx, 'authSecret', newSecret())
            await setSetting(tx, 'authUser', input.user)
            await setSetting(tx, 'authEnabled', input.enabled ? 'true' : 'false')
            forgetAuth()
            return { enabled: input.enabled }
        })),
})

export const appRouter = router({ perf: perfRouter, usage: usageRouter, item: itemRouter, note: noteRouter, run: runRouter, schedule: scheduleRouter, prompt: promptRouter, attachment: attachmentRouter, qa: qaRouter, agent: agentRouter, setting: settingRouter, auth: authRouter, game: gameRouter, feed: feedRouter, assets: assetsRouter, review: reviewRouter })
export type AppRouter = typeof appRouter
