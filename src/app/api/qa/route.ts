import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { db } from "~/server/db"
import { ATTACH_DIR } from "~/server/media"

// QA ingest: game machines push fuzz / visual / suite results here (scripts/qa-post.sh).
// Behind the same optional password as the rest of the panel (proxy.ts); no extra secret.
//   { kind: "fuzz"|"visual"|"suite", game, commit?, timestamp?, ok?,
//     summary: { total, failed, ...anything }, failures: [{ name, repro?, reasons?: string[] }],
//     attachments?: [{ name: "x.png", data: <base64>, note? }] }
const KINDS = new Set(["fuzz", "visual", "suite", "perf"])
const KEEP = 200
const MAX_IMAGE = 6_000_000
const MAX_IMAGES = 40
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : undefined)
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "")

export async function POST(req: Request) {
    let b: Record<string, unknown>
    try { b = await req.json() } catch { return Response.json({ error: "body is not JSON" }, { status: 400 }) }
    const kind = text(b.kind, 20)
    const game = text(b.game, 80).replace(/[^\w.-]/g, "_")
    if (!KINDS.has(kind) || !game) return Response.json({ error: "kind (fuzz|visual|suite|perf) and game are required" }, { status: 400 })
    const sum = (b.summary && typeof b.summary === "object" ? b.summary : {}) as Record<string, unknown>
    // fuzz summaries say pairs/failed, visual ones maps/ok: accept those names as well.
    const total = num(sum.total) ?? num(sum.pairs) ?? num(sum.maps) ?? 0
    const failedCount = num(sum.failed) ?? (num(sum.ok) !== undefined ? Math.max(0, total - (num(sum.ok) as number)) : Array.isArray(b.failures) ? b.failures.length : 0)
    const ok = typeof b.ok === "boolean" ? b.ok : failedCount === 0
    const when = b.timestamp ? new Date(String(b.timestamp)) : new Date()
    const ranAt = Number.isNaN(when.getTime()) ? new Date() : when
    const failures = (Array.isArray(b.failures) ? b.failures : []).slice(0, 500).map((f) => {
        const o = (f && typeof f === "object" ? f : { name: String(f) }) as Record<string, unknown>
        return {
            name: text(o.name, 200), repro: text(o.repro, 400), note: text(o.note, 400),
            reasons: (Array.isArray(o.reasons) ? o.reasons : []).slice(0, 20).map((r) => text(r, 400)),
        }
    })
    const files = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, MAX_IMAGES)
    const row = await db.qaRun.create({
        data: { kind, game, commit: text(b.commit, 64), ranAt, ok, total, failedCount, summary: JSON.stringify(sum).slice(0, 20_000), failures: JSON.stringify(failures) },
    })
    const images: { file: string; note: string }[] = []
    const dir = path.join(ATTACH_DIR, `qa-${row.id}`)
    for (const f of files) {
        const o = (f && typeof f === "object" ? f : {}) as Record<string, unknown>
        const name = path.basename(text(o.name, 120)).replace(/[^\w.-]/g, "_")
        if (!/\.(png|jpe?g)$/i.test(name) || typeof o.data !== "string") continue
        const buf = Buffer.from(o.data, "base64")
        if (buf.length === 0 || buf.length > MAX_IMAGE) continue
        await mkdir(dir, { recursive: true })
        await writeFile(path.join(dir, name), buf)
        images.push({ file: name, note: text(o.note, 200) })
    }
    if (images.length) await db.qaRun.update({ where: { id: row.id }, data: { images: JSON.stringify(images) } })
    // Keep the newest KEEP per game and kind; their images go with them.
    const old = await db.qaRun.findMany({ where: { game, kind }, orderBy: { ranAt: "desc" }, skip: KEEP, select: { id: true } })
    for (const o of old) await rm(path.join(ATTACH_DIR, `qa-${o.id}`), { recursive: true, force: true })
    if (old.length) await db.qaRun.deleteMany({ where: { id: { in: old.map((o) => o.id) } } })
    return Response.json({ id: row.id, ok, total, failed: failedCount, images: images.length }, { status: 201 })
}
