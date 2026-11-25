import { existsSync } from 'node:fs'
import { db } from './db'
import { ensureAssetColumns } from './assetsList'
import { aggregate, type Matrix } from '../../lib/asset-coverage.mjs'

export type EmptySource = { name: string; enabled: boolean; rootOk: boolean }
export type Coverage = Matrix & { empty: EmptySource[]; uncomputed: number; needs: Record<string, string[]> }

/** The coverage matrix for the Asset Manager: the per-row `coverage` column (written by the CLI after every scan / ingest) aggregated per pack and kind, plus sources with no rows. */
export async function assetCoverage(): Promise<Coverage> {
    await ensureAssetColumns()
    const rows = await db.$queryRawUnsafe<{ pack: string; kind: string; coverage: string }[]>('SELECT pack, kind, coverage FROM AssetWeapon')
    const m = aggregate(rows)
    const sources = await db.assetSource.findMany({ select: { name: true, enabled: true, root: true }, orderBy: { name: 'asc' } })
    const packs = new Set(rows.map((r) => r.pack))
    const empty = sources.filter((s) => !packs.has(s.name)).map((s) => ({ name: s.name, enabled: s.enabled, rootOk: !!s.root && existsSync(/*turbopackIgnore: true*/ s.root) }))
    const kinds = await db.assetKind.findMany({ select: { key: true, budget: true } })
    const needs: Record<string, string[]> = {}
    for (const k of kinds) { try { const b = JSON.parse(k.budget || '{}') as { needs?: unknown }; if (Array.isArray(b.needs)) needs[k.key] = b.needs.map(String) } catch { /* bad budget: shown without needs */ } }
    return { ...m, empty, uncomputed: rows.filter((r) => !r.coverage).length, needs }
}
