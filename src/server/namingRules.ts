import type { PrismaClient } from '../../generated/prisma/client'
import { loadRulesAsync } from '../../lib/naming-rules.mjs'
import { loadNameRulesAsync } from '../../lib/asset-names.mjs'

/** Load the `namingRules` setting (repo renames, game keywords...; lib/naming-rules.mjs) before code that classifies or maps repos. Cached 30 s. */
export const ensureNamingRules = (db: Pick<PrismaClient, 'setting'>) =>
    loadRulesAsync(async () => (await db.setting.findUnique({ where: { key: 'namingRules' } }))?.value ?? null)

/** Load the `assetNameRules` setting (legacy prefixes, kit-part words, map-piece folders; lib/asset-names.mjs) before code that names
 *  assets or builds tab SQL. Cached 30 s. */
export const ensureAssetNameRules = (db: Pick<PrismaClient, 'setting'>) =>
    loadNameRulesAsync(async () => (await db.setting.findUnique({ where: { key: 'assetNameRules' } }))?.value ?? null)
