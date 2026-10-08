import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { MEDIA_DIR, MEDIA_EXT } from '~/server/media'

// Run screenshots, read straight from the media dir. Behind the same password as the panel (proxy.ts).
export async function GET(_req: Request, ctx: RouteContext<'/media/[...path]'>) {
    const rel = (await ctx.params).path.map(decodeURIComponent).join('/')
    const file = path.resolve(MEDIA_DIR, rel)
    const type = MEDIA_EXT[path.extname(file).toLowerCase()]
    if (!type || !file.startsWith(MEDIA_DIR + path.sep)) return new Response('not found', { status: 404 })
    try {
        const body = await readFile(file)
        return new Response(body, {
            headers: {
                'content-type': type, 'cache-control': 'private, max-age=86400',
                // An SVG from a run is data, not a page: no scripts.
                ...(type === 'image/svg+xml' ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } : {}),
            },
        })
    } catch {
        return new Response('not found', { status: 404 })
    }
}
