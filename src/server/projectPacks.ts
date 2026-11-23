import { db } from './db'

/** The asset packs a project owns or uses (ProjectPack), or null for no project filter. An unknown project gives an empty list (nothing matches). */
export async function projectPacks(slug: string | undefined | null): Promise<string[] | null> {
    if (!slug) return null
    const rows = await db.projectPack.findMany({ where: { project: { slug } }, select: { pack: true }, orderBy: { pack: 'asc' } })
    return rows.map((r) => r.pack)
}
