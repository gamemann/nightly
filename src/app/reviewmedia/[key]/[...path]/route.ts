import { readFile } from "node:fs/promises"
import path from "node:path"
import { TYPES, mediaPath } from "../../../../../lib/review.mjs"

// Review media (filmstrips, clips, audio, waveforms). Behind the same password as the panel (proxy.ts). Range is honoured so audio and video seek.
export async function GET(req: Request, ctx: { params: Promise<{ key: string; path: string[] }> }) {
    const { key, path: parts } = await ctx.params
    const file = mediaPath(decodeURIComponent(key), parts.map(decodeURIComponent))
    if (!file) return new Response("not found", { status: 404 })
    try {
        const body = await readFile(file)
        const headers: Record<string, string> = { "content-type": TYPES[path.extname(file).toLowerCase()], "cache-control": "private, max-age=300", "accept-ranges": "bytes" }
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "")
        if (m && (m[1] || m[2])) {
            const start = m[1] ? Number(m[1]) : Math.max(0, body.length - Number(m[2]))
            const end = m[1] && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1
            if (start > end || start >= body.length) return new Response(null, { status: 416, headers: { "content-range": `bytes */${body.length}` } })
            return new Response(body.subarray(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${body.length}` } })
        }
        return new Response(body, { headers })
    } catch {
        return new Response("not found", { status: 404 })
    }
}
