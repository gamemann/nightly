import { readFileSync } from "node:fs"
import path from "node:path"
import { AUDIT_DIR } from "../../../../../../lib/assets-files.mjs"

export const dynamic = "force-dynamic"

// /api/assets/avatar/<file>: the figure bodies the viewer's third-person mode dresses with the weapon (avatars.json names the bodies and atlas), baked into
// <audit dir>/avatars by the pack's third-person export tool. Only a flat .json/.png/.glb name in that one directory, so the URL never picks a path.
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
    const { name } = await params
    if (!/^[a-z0-9][a-z0-9_-]*\.(json|png|glb)$/.test(name)) return new Response("bad request", { status: 400 })
    try {
        const buf = readFileSync(path.join(AUDIT_DIR(), "avatars", name))
        return new Response(new Uint8Array(buf), { headers: { "content-type": name.endsWith(".json") ? "application/json" : name.endsWith(".png") ? "image/png" : "model/gltf-binary", "cache-control": "private, max-age=60" } })
    } catch { return new Response("not found", { status: 404 }) }
}
