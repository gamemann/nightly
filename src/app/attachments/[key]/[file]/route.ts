import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ATTACH_DIR } from '~/server/media'

// Item screenshot attachments (nightly attach). Behind the same password as the panel (proxy.ts).
export async function GET(_req: Request, ctx: { params: Promise<{ key: string; file: string }> }) {
    const { key, file } = await ctx.params
    const safe = decodeURIComponent(key).replace(/[^\w.-]/g, '_')
    const name = decodeURIComponent(file)
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg' }[path.extname(name).toLowerCase()]
    if (!type || name !== path.basename(name)) return new Response('not found', { status: 404 })
    try {
        return new Response(await readFile(path.join(ATTACH_DIR, safe, name)), { headers: { 'content-type': type, 'cache-control': 'private, max-age=86400' } })
    } catch {
        return new Response('not found', { status: 404 })
    }
}
