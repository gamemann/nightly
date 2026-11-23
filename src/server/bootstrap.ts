import { execFile } from 'node:child_process'
import path from 'node:path'
import { db } from './db'
import { DEFAULT_ROLES } from '../../lib/permissions.mjs'
import { bootstrapPlan, migrationStatements } from '../../lib/accounts-core.mjs'
import { forgetIngest } from './auth'

// First start of the panel, run once per process (instrumentation.ts and the proxy both call it;
// only the first call does work). Idempotent:
//  1. the users/projects/nodes tables (CREATE ... IF NOT EXISTS, through Prisma; never db push)
//  2. the builtin roles admin and user
//  3. no user yet: the admin from the old single login, NIGHTLY_ADMIN_USER/NIGHTLY_ADMIN_PASSWORD,
//     or a generated password printed once to the server log
//  4. no project yet: `bin/nightly project seed` (the CLI scans the repo roots; one writer)
const MIGRATION = path.join(process.cwd(), 'prisma', 'migrations', '20261201000000_users_projects_nodes', 'migration.sql')

let done: Promise<void> | null = null
export const ensureBootstrap = () => (done ??= run().catch((e) => { done = null; console.error('[nightly] bootstrap failed:', e) }))

async function run() {
    for (const st of migrationStatements(MIGRATION)) await db.$executeRawUnsafe(st)
    const now = new Date()
    for (const [name, r] of Object.entries(DEFAULT_ROLES)) {
        if (await db.role.findUnique({ where: { name } })) continue
        await db.role.create({ data: { name, description: r.description, builtin: true, createdAt: now, grants: { create: r.grants.map((perm) => ({ perm, allow: true })) } } })
    }
    if (!(await db.user.findFirst({ select: { id: true } }))) {
        const rows = await db.setting.findMany({ where: { key: { in: ['authEnabled', 'authUser', 'authHash'] } } })
        const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]))
        const hasData = !!(await db.item.findFirst({ select: { id: true } }))
        const plan = bootstrapPlan({ settings, env: process.env, hasData })
        const admin = await db.role.findUniqueOrThrow({ where: { name: 'admin' } })
        await db.user.create({ data: { username: plan.username, name: 'Administrator', hash: plan.hash, createdAt: now, updatedAt: now, roles: { create: [{ roleId: admin.id }] } } })
        if (plan.ingestOpen && !(await db.setting.findUnique({ where: { key: 'ingestOpen' } }))) await db.setting.create({ data: { key: 'ingestOpen', value: 'true' } })
        forgetIngest()
        if (plan.source === 'generated') console.log(`[nightly] created admin "${plan.username}" with password: ${plan.password}  (shown once; change it under Account)`)
        else console.log(`[nightly] created admin "${plan.username}" from ${plan.source === 'legacy' ? 'the old login settings' : 'NIGHTLY_ADMIN_USER/NIGHTLY_ADMIN_PASSWORD'}`)
    }
    if (!(await db.project.findFirst({ select: { id: true } }))) {
        execFile(path.join(process.cwd(), 'bin', 'nightly'), ['project', 'seed'], { timeout: 120_000 }, (err, stdout) => {
            if (err) console.error('[nightly] project seed failed:', err.message)
            else console.log(`[nightly] project seed: ${stdout.trim().split('\n')[0] ?? ''}`)
        })
    }
}
