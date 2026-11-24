import { readFileSync } from "node:fs"
import path from "node:path"
import { AUDIT_DIR } from "../../../../../../lib/assets-files.mjs"

export const dynamic = "force-dynamic"

// /api/assets/avatar/<avatars.json|atlas_people.png|people_<body>.glb>: the figure bodies the viewer's third-person mode dresses with the weapon, baked next to the
// audit by fc-weapons' tools/export_third_person.gd. A fixed name list, so the URL never picks a path.
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
    const { name } = await params
    if (!/^(avatars\.json|atlas_people\.png|people_[a-z0-9]+\.glb)$/.test(name)) return new Response("bad request", { status: 400 })
    try {
        const buf = readFileSync(path.join(AUDIT_DIR(), "avatars", name))
        return new Response(new Uint8Array(buf), { headers: { "content-type": name.endsWith(".json") ? "application/json" : name.endsWith(".png") ? "image/png" : "model/gltf-binary", "cache-control": "private, max-age=60" } })
    } catch { return new Response("not found", { status: 404 }) }
}
