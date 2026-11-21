import { readFile } from "node:fs/promises"
import path from "node:path"
import { db } from "~/server/db"

// Raw artefacts of a run (the stored report.json / stacks.folded / report.txt), behind the same optional password as the panel.
const FILES = new Set(["report.json", "stacks.folded", "report.txt"])
const PERF_DIR = () => process.env.NIGHTLY_PERF_DIR || path.join(path.dirname(process.env.NIGHTLY_DB || path.join(process.cwd(), "data", "nightly.db")), "perf")

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
    const { id, file } = await params
    if (!FILES.has(file)) return Response.json({ error: "not found" }, { status: 404 })
    const run = await db.perfRun.findUnique({ where: { id: Number(id) }, select: { artefact: true } })
    if (!run?.artefact) return Response.json({ error: "not found" }, { status: 404 })
    try {
        return new Response(await readFile(path.join(PERF_DIR(), run.artefact, file)), { headers: { "content-type": file.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8" } })
    } catch { return Response.json({ error: "artefact missing on disk" }, { status: 404 }) }
}
