import { readFileSync } from "node:fs"
import { db } from "~/server/db"
import { resolveFile, setExtraRoots } from "../../../../../../lib/assets-files.mjs"

export const dynamic = "force-dynamic"

// /api/assets/original/<map id>: what the map's ORIGINAL (source BSP exported to GLB) is made of: its source materials (Valve names) and mesh counts.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    if (!/^\d+$/.test(id)) return new Response("bad request", { status: 400 })
    setExtraRoots((await db.assetSource.findMany({ select: { root: true } })).map((s) => s.root))
    const row = await db.assetWeapon.findUnique({ where: { id: Number(id) }, select: { data: true } })
    if (!row) return new Response("not found", { status: 404 })
    const r = resolveFile(JSON.parse(row.data), "orig", 0)
    if (!r?.file) return Response.json({ materials: [], meshes: 0, nodes: 0, images: 0 })
    try {
        const b = readFileSync(r.file)
        const n = b.readUInt32LE(12)
        const j = JSON.parse(b.subarray(20, 20 + n).toString("utf8")) as { materials?: { name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[] } }[]; meshes?: unknown[]; nodes?: unknown[]; images?: unknown[] }
        const materials = (j.materials ?? []).map((m) => ({ name: m.name ?? "", color: m.pbrMetallicRoughness?.baseColorFactor ?? null }))
        return Response.json({ materials, meshes: j.meshes?.length ?? 0, nodes: j.nodes?.length ?? 0, images: j.images?.length ?? 0, bytes: b.length })
    } catch { return Response.json({ error: "original unreadable" }, { status: 500 }) }
}
