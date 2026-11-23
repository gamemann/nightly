import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ICON_MAX_BYTES, iconFile, iconType, sniffImage } from '../../../../../../lib/icons.mjs'
import { viewerFromRequest } from '~/server/auth'
import { db } from '~/server/db'
import { assertProject } from '~/server/projectsRouter'

// A project's icon. GET serves it to anyone who may see the project; POST (multipart field "file",
// or a raw image body) replaces it and needs projects.edit on the project; DELETE removes it.
// Files live next to the database in icons/, never in the repository.
const ICON_DIR = () => process.env.NIGHTLY_ICON_DIR || path.join(path.dirname(process.env.NIGHTLY_DB || path.join(process.cwd(), 'data', 'nightly.db')), 'icons')
type Ctx = { params: Promise<{ slug: string }> }
const fail = (status: number, error: string) => Response.json({ error }, { status })

async function load(req: Request, ctx: Ctx, perm: string) {
    const { slug } = await ctx.params
    const p = await db.project.findUnique({ where: { slug }, select: { id: true, icon: true } })
    if (!p) return { err: fail(404, 'no such project') }
    try {
        await assertProject(await viewerFromRequest(req), perm, p.id)
    } catch {
        return { err: fail(403, 'no access to this project') }
    }
    return { p }
}

export async function GET(req: Request, ctx: Ctx) {
    const { p, err } = await load(req, ctx, 'projects.view')
    if (err) return err
    const type = iconType(p.icon)
    if (!type) return fail(404, 'no icon')
    try {
        return new Response(await readFile(path.join(ICON_DIR(), p.icon!)), { headers: { 'content-type': type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' } })
    } catch {
        return fail(404, 'no icon')
    }
}

export async function POST(req: Request, ctx: Ctx) {
    const { p, err } = await load(req, ctx, 'projects.edit')
    if (err) return err
    if (Number(req.headers.get('content-length') ?? 0) > ICON_MAX_BYTES + 4096) return fail(413, `icon larger than ${ICON_MAX_BYTES >> 10} KB`)
    let buf: Buffer
    if ((req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
        const f = (await req.formData()).get('file')
        if (!(f instanceof Blob)) return fail(400, 'no file')
        buf = Buffer.from(await f.arrayBuffer())
    } else buf = Buffer.from(await req.arrayBuffer())
    if (buf.length > ICON_MAX_BYTES) return fail(413, `icon larger than ${ICON_MAX_BYTES >> 10} KB`)
    const kind = sniffImage(buf)
    if (!kind) return fail(415, 'icon must be png, jpeg, gif or webp')
    const name = iconFile(p.id, kind.ext)
    await mkdir(ICON_DIR(), { recursive: true })
    await writeFile(path.join(ICON_DIR(), name), buf)
    await db.project.update({ where: { id: p.id }, data: { icon: name, updatedAt: new Date() } })
    if (iconType(p.icon)) await unlink(path.join(ICON_DIR(), p.icon!)).catch(() => {})
    return Response.json({ icon: name })
}

export async function DELETE(req: Request, ctx: Ctx) {
    const { p, err } = await load(req, ctx, 'projects.edit')
    if (err) return err
    await db.project.update({ where: { id: p.id }, data: { icon: '', updatedAt: new Date() } })
    if (iconType(p.icon)) await unlink(path.join(ICON_DIR(), p.icon!)).catch(() => {})
    return Response.json({ ok: true })
}
