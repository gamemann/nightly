import { createReadStream, statSync } from "node:fs"
import { Readable } from "node:stream"
import path from "node:path"
import { db } from "~/server/db"
import { resolveFile, setExtraRoots } from "../../../../../../../../lib/assets-files.mjs"

export const dynamic = "force-dynamic"
const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ogg": "audio/ogg", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".json": "application/json" }

// /api/assets/file/<weapon id>/<glb|orig|tex|snd>/<index>: the weapon's model, a texture or a sound. Only files under the configured roots
// (a registered source root, NIGHTLY_ASSET_ROOTS, or the audit dir) are served; the path comes from the stored audit row, never the URL.
export async function GET(req: Request, { params }: { params: Promise<{ id: string; kind: string; idx: string }> }) {
    const { id, kind, idx } = await params
    if (!/^\d+$/.test(id) || !["glb", "orig", "tex", "snd", "anim"].includes(kind) || !/^\d+$/.test(idx)) return new Response("bad request", { status: 400 })
    setExtraRoots((await db.assetSource.findMany({ select: { root: true } })).map((s) => s.root))
    const row = await db.assetWeapon.findUnique({ where: { id: Number(id) }, select: { data: true } })
    if (!row) return new Response("not found", { status: 404 })
    const r = resolveFile(JSON.parse(row.data), kind, Number(idx))
    if (!r) return new Response("not found", { status: 404 })
    const headers: Record<string, string> = { "accept-ranges": "bytes", "cache-control": "private, max-age=60" }
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "")
    const range = (size: number) => {
        if (!m || !(m[1] || m[2])) return null
        const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
        const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
        return { start, end, ok: start < size && start <= end }
    }
    if (r.file) {
        // a file is streamed, not read whole: a converted map's glb is 100+ MB, and buffering it (twice) per request held the
        // server and delayed the first byte. The etag lets a revisit skip the download.
        let size: number, tag: string
        try { const s = statSync(r.file); size = s.size; tag = `"${s.size.toString(36)}-${Math.floor(s.mtimeMs).toString(36)}"` } catch { return new Response("file missing", { status: 404 }) }
        Object.assign(headers, { "content-type": r.mime ?? TYPES[path.extname(r.file).toLowerCase()] ?? "application/octet-stream", etag: tag })
        if (req.headers.get("if-none-match") === tag) return new Response(null, { status: 304, headers })
        const rg = range(size)
        if (rg && !rg.ok) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } })
        const body = Readable.toWeb(createReadStream(r.file, rg ? { start: rg.start, end: rg.end } : {})) as ReadableStream<Uint8Array>
        if (rg) return new Response(body, { status: 206, headers: { ...headers, "content-range": `bytes ${rg.start}-${rg.end}/${size}`, "content-length": String(rg.end - rg.start + 1) } })
        return new Response(body, { headers: { ...headers, "content-length": String(size) } })
    }
    const buf = r.bytes ?? Buffer.alloc(0)
    headers["content-type"] = r.mime ?? "application/octet-stream"
    const rg = range(buf.length)
    if (rg) {
        if (!rg.ok) return new Response(null, { status: 416, headers: { "content-range": `bytes */${buf.length}` } })
        return new Response(new Uint8Array(buf.subarray(rg.start, rg.end + 1)), { status: 206, headers: { ...headers, "content-range": `bytes ${rg.start}-${rg.end}/${buf.length}`, "content-length": String(rg.end - rg.start + 1) } })
    }
    return new Response(new Uint8Array(buf), { headers: { ...headers, "content-length": String(buf.length) } })
}
