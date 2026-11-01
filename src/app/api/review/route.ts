import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { db } from "~/server/db"
import { addMedia, load, open, setVerdict } from "../../../../lib/review.mjs"

// Review ingest (scripts/review-post.sh) and read-back. Behind the same optional password as the panel (proxy.ts).
//   { action: "new", title, key?, body? }
//   { action: "media", key, weapon, slot, variant?, label?, licence?, source?, note?, title?, name: "x.png", data: <base64>, waveform?: <base64 png> }
//   { action: "verdict", key, weapon, verdict: "good"|"wrong"|"", note?, by? }
// GET /api/review lists the reviews; ?key=K returns the weapons with verdicts and notes; &open=1 only those not yet good.
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "")
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "review"

export async function GET(req: Request) {
    const u = new URL(req.url)
    const key = u.searchParams.get("key")
    if (!key) {
        const items = await db.item.findMany({ where: { kind: "review" }, orderBy: { id: "desc" }, select: { key: true, title: true } })
        return Response.json(items.map((i) => ({ ...i, open: open(i.key).length })))
    }
    if (!(await db.item.findUnique({ where: { key } }))) return Response.json({ error: "no such review" }, { status: 404 })
    return Response.json(u.searchParams.get("open") ? open(key) : load(key).weapons)
}

export async function POST(req: Request) {
    let b: Record<string, unknown>
    try { b = await req.json() } catch { return Response.json({ error: "body is not JSON" }, { status: 400 }) }
    const action = text(b.action, 20)
    try {
        if (action === "new") {
            const title = text(b.title, 200)
            if (!title) return Response.json({ error: "title is required" }, { status: 400 })
            let key = text(b.key, 80) || slug(title)
            const existing = await db.item.findUnique({ where: { key } })
            if (existing && existing.kind === "review") return Response.json({ key, existed: true })
            if (existing) key = `${key}-review`
            const max = await db.item.aggregate({ _max: { priority: true } })
            await db.item.create({ data: { key, title, body: text(b.body, 4000), kind: "review", status: "review", priority: (max._max.priority ?? 0) + 1, addedBy: "session" } })
            return Response.json({ key }, { status: 201 })
        }
        const key = text(b.key, 80)
        const item = key ? await db.item.findUnique({ where: { key } }) : null
        if (!item || item.kind !== "review") return Response.json({ error: "no such review item (action new first)" }, { status: 404 })
        const weapon = text(b.weapon, 80)
        if (!weapon) return Response.json({ error: "weapon is required" }, { status: 400 })
        if (action === "verdict") {
            return Response.json(setVerdict(key, weapon, text(b.verdict, 10), { note: text(b.note, 2000), by: text(b.by, 40) || "christian" }))
        }
        if (action === "media") {
            const name = path.basename(text(b.name, 120)).replace(/[^\w.-]/g, "_")
            if (!name || typeof b.data !== "string") return Response.json({ error: "name and data (base64) are required" }, { status: 400 })
            const dir = await mkdtemp(path.join(os.tmpdir(), "review-"))
            try {
                const src = path.join(dir, name)
                await writeFile(src, Buffer.from(b.data, "base64"))
                let waveform = ""
                if (typeof b.waveform === "string" && b.waveform) { waveform = path.join(dir, "wave.png"); await writeFile(waveform, Buffer.from(b.waveform, "base64")) }
                const m = addMedia(key, weapon, src, {
                    slot: text(b.slot, 20), variant: text(b.variant, 10), label: text(b.label, 80), licence: text(b.licence, 200), source: text(b.source, 400),
                    note: text(b.note, 400), title: text(b.title, 120), waveform, by: text(b.by, 40) || "session",
                    look: text(b.look, 300), metrics: b.metrics as never, entryLook: text(b.entry_look, 300), entryMetrics: b.entry_metrics as never,
                })
                return Response.json(m, { status: 201 })
            } finally {
                await rm(dir, { recursive: true, force: true })
            }
        }
        return Response.json({ error: "action must be new, media or verdict" }, { status: 400 })
    } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
    }
}
