import { db } from "~/server/db"

// Pinned notes on a picture (x, y fractions) or its model (x, y, z + normal). Behind the same optional password as the panel (proxy.ts).
//   GET    ?item=<key>&target=<file>        list
//   POST   { item, target, kind: "model"|"image", x, y, z?, nx?, ny?, nz?, text, author? }
//   DELETE ?id=<n>
const fin = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "")

export async function GET(req: Request) {
    const u = new URL(req.url)
    const item = u.searchParams.get("item"), target = u.searchParams.get("target")
    if (!item) return Response.json({ error: "item is required" }, { status: 400 })
    const rows = await db.annotation.findMany({ where: { itemKey: item, ...(target ? { target } : {}) }, orderBy: { id: "asc" }, take: 500 })
    return Response.json(rows)
}

export async function POST(req: Request) {
    let b: Record<string, unknown>
    try { b = await req.json() } catch { return Response.json({ error: "body is not JSON" }, { status: 400 }) }
    const item = text(b.item, 120), target = text(b.target, 200), note = text(b.text, 2000).trim()
    const kind = b.kind === "model" || b.kind === "image" ? b.kind : ""
    if (!item || !target || !kind || !note) return Response.json({ error: "item, target, kind (model|image) and text are required" }, { status: 400 })
    if (target !== target.split("/").pop()) return Response.json({ error: "target is a file name" }, { status: 400 })
    const row = await db.annotation.create({
        data: { itemKey: item, kind, target, x: fin(b.x), y: fin(b.y), z: fin(b.z), nx: fin(b.nx), ny: fin(b.ny), nz: fin(b.nz), text: note, author: text(b.author, 40).trim() || "christian" },
    })
    return Response.json(row, { status: 201 })
}

export async function DELETE(req: Request) {
    const id = Number(new URL(req.url).searchParams.get("id"))
    if (!Number.isInteger(id)) return Response.json({ error: "id is required" }, { status: 400 })
    const r = await db.annotation.deleteMany({ where: { id } })
    return Response.json({ deleted: r.count }, { status: r.count ? 200 : 404 })
}
