import type { Prisma } from '../../generated/prisma/client'
import { makeResolver } from '../../lib/project-map.mjs'

type Tx = Prisma.TransactionClient

/** Slugs → the repos text stored on the item (the recoverable original), joined with ", ". */
export const reposText = (repos: string | undefined, projects: string[] | undefined) =>
    (projects?.length ? projects : (repos ?? '').split(','))
        .map((s) => s.trim()).filter(Boolean).join(', ')

/**
 * Rebuild ItemProject for one item from its repos text through the same resolver the CLI mapper uses
 * (lib/project-map.mjs), so panel edits and `nightly project map` agree. Returns the linked slugs.
 */
export async function syncItemLinks(tx: Tx, itemId: number): Promise<string[]> {
    const it = await tx.item.findUnique({ where: { id: itemId }, select: { id: true, key: true, title: true, repos: true } })
    if (!it) return []
    const projects = await tx.project.findMany({ select: { id: true, slug: true, type: true, repoPath: true, settings: true } })
    const r = makeResolver(projects).resolveItem(it.repos, it.key, it.title)
    const id = new Map(projects.map((p) => [p.slug, p.id]))
    await tx.itemProject.deleteMany({ where: { itemId } })
    const seen = new Set<number>()
    const data = r.links.flatMap((l) => {
        const pid = id.get(l.slug)
        if (pid == null || seen.has(pid)) return []
        seen.add(pid)
        return [{ itemId, projectId: pid, via: l.via, token: l.token }]
    })
    if (data.length) await tx.itemProject.createMany({ data })
    return data.map((d) => projects.find((p) => p.id === d.projectId)!.slug)
}
