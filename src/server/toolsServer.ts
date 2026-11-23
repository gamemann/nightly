import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { canProject } from '../../lib/permissions.mjs'
import { viewerCan, viewerFromRequest, type Viewer } from './auth'
import { db } from './db'
import { projectScope } from './projectsRouter'

const execp = promisify(execFile)

/** The write path of the game tools: `bin/nightly <args> --json`, so the panel and the CLI share one implementation. */
export async function toolsCli(args: string[]): Promise<unknown> {
    try {
        const { stdout } = await execp(path.join(process.cwd(), 'bin', 'nightly'), [...args, '--json'], { timeout: 900_000, maxBuffer: 64 << 20 })
        return stdout.trim() ? JSON.parse(stdout) : {}
    } catch (e) {
        const err = e as { stderr?: string; message: string }
        throw new Error((err.stderr || err.message).replace(/^nightly: /, '').trim())
    }
}

/** Saves an uploaded File to a temp directory (named as uploaded), runs `fn(path)` and removes it again. */
export async function withTempFile<T>(file: File, fn: (p: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nightly-up-'))
    try {
        const p = path.join(dir, path.basename(file.name).replace(/[^\w.\-]/g, "_") || "upload")
        await writeFile(p, Buffer.from(await file.arrayBuffer()))
        return await fn(p)
    } finally { await rm(dir, { recursive: true, force: true }) }
}

/** The signed-in viewer of a tools route holding `perm`, or the refusing Response (401 not signed in, 403 missing the permission).
 *  With `projectSlug` (a project's slug or its perf game slug) the work is filed under that project: the viewer needs `perm`
 *  and projects.view there, globally or through a project/folder grant; an unknown slug is refused (400). */
export async function toolViewer(req: Request, perm: string, projectSlug?: string): Promise<{ viewer: Viewer } | { deny: Response }> {
    const viewer = await viewerFromRequest(req)
    if (!viewer) return { deny: Response.json({ error: 'sign in first' }, { status: 401 }) }
    if (!projectSlug) {
        if (!viewerCan(viewer, perm)) return { deny: Response.json({ error: `missing permission ${perm}` }, { status: 403 }) }
        return { viewer }
    }
    const id = await projectIdOf(projectSlug)
    if (id === null) return { deny: Response.json({ error: `unknown project ${projectSlug}` }, { status: 400 }) }
    const scope = await projectScope(viewer)
    for (const k of [perm, 'projects.view']) if (!canProject(viewer.perms, scope, k, id)) return { deny: Response.json({ error: `missing permission ${k} on ${projectSlug}` }, { status: 403 }) }
    return { viewer }
}

/** A project id by slug, or by the perf game slug in its settings (tools jobs store the game slug). */
async function projectIdOf(slug: string): Promise<number | null> {
    const p = await db.project.findUnique({ where: { slug }, select: { id: true } })
    if (p) return p.id
    const all = await db.project.findMany({ select: { id: true, settings: true } })
    const hit = all.find((x) => { try { return (JSON.parse(x.settings || '{}') as { perfGame?: string }).perfGame === slug } catch { return false } })
    return hit?.id ?? null
}
