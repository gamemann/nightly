import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { AUDIT_DIR } from "../../../../../../lib/assets-files.mjs"

export const dynamic = "force-dynamic"

// /api/assets/thumb/<asset id>?k=tex|model&h=<file hash>: the cached 128x96 webp made by `nightly assets thumbs`.
// The file name carries the source hash, so a changed asset gets a new file; `h` in the URL only busts browser caches.
// Missing thumbnails answer 204 (an <img> then fires onError and the page shows a placeholder; a 404 would log a console error per row); generation never happens here.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const k = new URL(req.url).searchParams.get("k") ?? "model"
    if (!/^\d+$/.test(id) || !["tex", "model"].includes(k)) return new Response("bad request", { status: 400 })
    const dir = path.join(AUDIT_DIR(), "thumbs")
    let name: string | undefined
    try { name = readdirSync(dir).find((f) => f.startsWith(`${id}-${k}-`) && f.endsWith(".webp")) } catch { /* no thumbs yet */ }
    if (!name) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
    const etag = `"${name}"`
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } })
    const buf = readFileSync(path.join(dir, name))
    return new Response(new Uint8Array(buf), { headers: { "content-type": "image/webp", "cache-control": "public, max-age=86400, stale-while-revalidate=604800", etag, "content-length": String(buf.length) } })
}
