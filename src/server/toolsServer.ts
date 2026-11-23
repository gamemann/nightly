import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { viewerCan, viewerFromRequest, type Viewer } from './auth'

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

/** The signed-in viewer of a tools route holding `perm`, or the refusing Response (401 not signed in, 403 missing the permission). */
export async function toolViewer(req: Request, perm: string): Promise<{ viewer: Viewer } | { deny: Response }> {
    const viewer = await viewerFromRequest(req)
    if (!viewer) return { deny: Response.json({ error: 'sign in first' }, { status: 401 }) }
    if (!viewerCan(viewer, perm)) return { deny: Response.json({ error: `missing permission ${perm}` }, { status: 403 }) }
    return { viewer }
}
