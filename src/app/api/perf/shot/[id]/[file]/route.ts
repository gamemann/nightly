import { readFile } from "node:fs/promises"
import path from "node:path"

// A stored screenshot (png), behind the same optional password as the panel.
const PERF_DIR = () => process.env.NIGHTLY_PERF_DIR || path.join(path.dirname(process.env.NIGHTLY_DB || path.join(process.cwd(), "data", "nightly.db")), "perf")

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
    const { id, file } = await params
    if (!/^\d+$/.test(id) || !/^[\w-]+\.png$/.test(file)) return Response.json({ error: "not found" }, { status: 404 })
    try {
        return new Response(await readFile(path.join(PERF_DIR(), "shots", id, file)), { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } })
    } catch { return Response.json({ error: "not found" }, { status: 404 }) }
}
