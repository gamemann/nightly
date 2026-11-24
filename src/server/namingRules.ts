import type { PrismaClient } from '../../generated/prisma/client'
import { loadRulesAsync } from '../../lib/naming-rules.mjs'

/** Load the `namingRules` setting (repo renames, game keywords...; lib/naming-rules.mjs) before code that classifies or maps repos. Cached 30 s. */
export const ensureNamingRules = (db: Pick<PrismaClient, 'setting'>) =>
    loadRulesAsync(async () => (await db.setting.findUnique({ where: { key: 'namingRules' } }))?.value ?? null)
