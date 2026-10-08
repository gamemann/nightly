import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { Prisma, PrismaClient } from '../../generated/prisma/client'
import { cronError, nextFires } from '../../lib/cron.mjs'
import { CADENCES, KINDS, LIVE_MINUTES, OPEN_STATUSES, STATUSES, isDue, slugify } from '~/lib/constants'
import { AUTH_KEYS, PRIVATE_SETTINGS, forgetAuth, hashPassword, newSecret } from './auth'
import { MEDIA_DIR, MEDIA_EXT } from './media'
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
    list: procedure
        .input(z.object({ view: z.enum(VIEWS), q: z.string().optional() }))
        .query(async ({ ctx, input }) => {
            const q = input.q?.trim()
            const where: Prisma.ItemWhereInput = {
                ...(q ? {} : whereFor(input.view)),
                ...(q ? { OR: [{ title: { contains: q } }, { key: { contains: q } }, { body: { contains: q } }, { repos: { contains: q } }] } : {}),
            }
            const done = input.view === 'done'
            const items = await ctx.db.item.findMany({
                where,
                orderBy: done ? [{ completedAt: 'desc' }, { id: 'desc' }] : [{ priority: 'asc' }, { id: 'asc' }],
                take: done || q ? 300 : undefined,
                select: {
                    id: true, key: true, title: true, kind: true, status: true, priority: true, repos: true, cadence: true,
                    lastRunAt: true, completedAt: true, updatedAt: true, addedBy: true, _count: { select: { notes: true } },
                },
            })
            return items.map((i) => ({ ...i, due: isDue(i) }))
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
            include: { notes: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { run: { select: { id: true, startedAt: true } } } } },
        })
        if (!it) throw new TRPCError({ code: 'NOT_FOUND', message: `no item ${input.key}` })
        return { ...it, due: isDue(it) }
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
                    repos: input.repos.split(',').map((s) => s.trim()).filter(Boolean).join(', '),
                    doneWhen: input.doneWhen || null, addedBy: 'christian',
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
        if (input.note?.trim()) await ctx.db.note.create({ data: { itemId: it.id, author: 'christian', body: input.note.trim() } })
        return it
    }),

    delete: procedure.input(keyInput).mutation(({ ctx, input }) => ctx.db.item.delete({ where: { key: input.key } })),
})

const noteRouter = router({
    add: procedure
        .input(z.object({ key: z.string(), body: z.string().trim().min(1), author: z.string().default('christian') }))
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
    list: procedure.input(z.object({ q: z.string().optional(), scheduleId: z.number().optional() }).optional()).query(({ ctx, input }) => {
        const q = input?.q?.trim()
        return ctx.db.run.findMany({
            where: {
                ...(q ? { OR: [{ summary: { contains: q } }, { report: { contains: q } }, { log: { contains: q } }] } : {}),
                ...(input?.scheduleId ? { scheduleId: input.scheduleId } : {}),
            },
            orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
            take: 500,
            select: {
                id: true, startedAt: true, finishedAt: true, status: true, summary: true, turns: true, minutes: true, costUsd: true, trigger: true,
                schedule: { select: { id: true, name: true } }, _count: { select: { notes: true } },
            },
        })
    }),
    get: procedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
        const r = await ctx.db.run.findUnique({
            where: { id: input.id },
            include: {
                schedule: { select: { id: true, name: true, prompt: true } },
                notes: { orderBy: { id: 'asc' }, include: { item: { select: { key: true, title: true, status: true } } } },
            },
        })
        if (!r) throw new TRPCError({ code: 'NOT_FOUND' })
        return r
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
    list: procedure.query(async ({ ctx }) => {
        const rows = await ctx.db.schedule.findMany({
            orderBy: { id: 'asc' },
            include: { runs: { orderBy: { startedAt: 'desc' }, take: 1, select: { id: true, status: true, startedAt: true, summary: true } } },
        })
        const now = new Date()
        return rows.map(({ runs, ...s }) => {
            const error = cronError(s.cron)
            return { ...s, error, next: error ? [] : nextFires(s.cron, now, 3), lastRun: runs[0] ?? null }
        })
    }),
    /** Next fire times for an expression being typed (or why it is invalid). */
    preview: procedure.input(z.object({ cron: z.string() })).query(({ input }) => {
        const error = cronError(input.cron)
        return { error, next: error ? [] : nextFires(input.cron, new Date(), 3) }
    }),
    /** The prompts a schedule can start with. */
    prompts: procedure.query(async ({ ctx }) =>
        (await ctx.db.prompt.findMany({ where: { kind: 'prompt' }, orderBy: { name: 'asc' }, select: { name: true } })).map((p) => p.name)),
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
    list: procedure.query(async ({ ctx }) => {
        const [rows, schedules] = await Promise.all([
            ctx.db.prompt.findMany({ orderBy: [{ kind: 'asc' }, { name: 'asc' }], select: { id: true, name: true, kind: true, body: true, updatedAt: true } }),
            ctx.db.schedule.findMany({ select: { name: true, prompt: true } }),
        ])
        return rows.map(({ body, ...p }) => ({ ...p, size: body.length, usedBy: schedules.filter((s) => s.prompt === p.name).map((s) => s.name) }))
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
            if (!cur || cur.body !== input.body) await tx.promptVersion.create({ data: { promptId: p.id, body: input.body, author: 'christian', note: input.note } })
            return p
        })),
    delete: procedure.input(z.object({ name: z.string() })).mutation(async ({ ctx, input }) => {
        const used = await ctx.db.schedule.findMany({ where: { prompt: input.name }, select: { name: true } })
        if (used.length) throw new TRPCError({ code: 'CONFLICT', message: `used by schedule ${used.map((s) => `"${s.name}"`).join(', ')}` })
        await ctx.db.prompt.delete({ where: { name: input.name } })
    }),
})

const liveSince = () => new Date(Date.now() - LIVE_MINUTES * 60_000)

const agentRouter = router({
    board: procedure.query(async ({ ctx }) => {
        const [agents, recent, claims, messages] = await Promise.all([
            ctx.db.agent.findMany({ where: { endedAt: null }, orderBy: { startedAt: 'asc' } }),
            ctx.db.agent.findMany({
                where: { endedAt: { gte: new Date(Date.now() - 24 * 3600_000) } }, orderBy: { endedAt: 'desc' }, take: 20,
            }),
            ctx.db.claim.findMany({ where: { releasedAt: null }, orderBy: { createdAt: 'asc' }, include: { agent: { select: { name: true, kind: true, lastSeenAt: true, endedAt: true } } } }),
            ctx.db.message.findMany({ orderBy: { id: 'desc' }, take: 200 }),
        ])
        const since = liveSince()
        return {
            live: agents.filter((a) => a.lastSeenAt >= since),
            quiet: agents.filter((a) => a.lastSeenAt < since),
            ended: recent,
            claims: claims.map((c) => ({ ...c, stale: !!c.agent.endedAt || c.agent.lastSeenAt < since })),
            messages: messages.reverse(),
        }
    }),
    liveCount: procedure.query(({ ctx }) => ctx.db.agent.count({ where: { endedAt: null, lastSeenAt: { gte: liveSince() } } })),
    post: procedure.input(z.object({ body: z.string().trim().min(1).max(4000), to: z.string().trim().optional() })).mutation(({ ctx, input }) =>
        ctx.db.message.create({ data: { author: 'christian', body: input.body, to: input.to || null } })),
    release: procedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
        const c = await ctx.db.claim.update({ where: { id: input.id }, data: { releasedAt: new Date() }, include: { agent: true } })
        await ctx.db.message.create({ data: { author: 'board', body: `christian released ${c.agent.name}'s claim on ${c.scope}` } })
    }),
    /** End a session that went away without leaving (its claims go with it). */
    end: procedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
        const t = new Date()
        const a = await ctx.db.agent.update({ where: { id: input.id }, data: { endedAt: t } })
        await ctx.db.claim.updateMany({ where: { agentId: a.id, releasedAt: null }, data: { releasedAt: t } })
        await ctx.db.message.create({ data: { author: 'board', body: `christian ended ${a.name}` } })
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

export const appRouter = router({ item: itemRouter, note: noteRouter, run: runRouter, schedule: scheduleRouter, prompt: promptRouter, agent: agentRouter, setting: settingRouter, auth: authRouter })
export type AppRouter = typeof appRouter
