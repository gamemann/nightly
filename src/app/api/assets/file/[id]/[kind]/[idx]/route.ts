import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { db } from "~/server/db"
import { resolveFile } from "../../../../../../../../lib/assets.mjs"

export const dynamic = "force-dynamic"
const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ogg": "audio/ogg", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json" }

// /api/assets/file/<weapon id>/<glb|tex|snd>/<index>: the weapon's model, a texture or a sound. Only files under the configured roots
// (NIGHTLY_ASSET_ROOTS, default the godot tree and the rsi-assets dir) are served; the path comes from the stored audit row, never the URL.
export async function GET(req: Request, { params }: { params: Promise<{ id: string; kind: string; idx: string }> }) {
    const { id, kind, idx } = await params
    if (!/^\d+$/.test(id) || !["glb", "tex", "snd"].includes(kind) || !/^\d+$/.test(idx)) return new Response("bad request", { status: 400 })
    const row = await db.assetWeapon.findUnique({ where: { id: Number(id) }, select: { data: true } })
    if (!row) return new Response("not found", { status: 404 })
    const r = resolveFile(JSON.parse(row.data), kind, Number(idx))
    if (!r) return new Response("not found", { status: 404 })
    let buf: Buffer
    let mime = r.mime
    try {
        if (r.file) { statSync(r.file); buf = readFileSync(r.file); mime ??= TYPES[path.extname(r.file).toLowerCase()] } else buf = r.bytes ?? Buffer.alloc(0)
    } catch { return new Response("file missing", { status: 404 }) }
    const headers: Record<string, string> = { "content-type": mime ?? "application/octet-stream", "accept-ranges": "bytes", "cache-control": "private, max-age=60" }
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "")
    if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(0, buf.length - Number(m[2]))
        const end = m[1] && m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1
        if (start >= buf.length || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${buf.length}` } })
        return new Response(new Uint8Array(buf.subarray(start, end + 1)), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${buf.length}`, "content-length": String(end - start + 1) } })
    }
    return new Response(new Uint8Array(buf), { headers: { ...headers, "content-length": String(buf.length) } })
}
