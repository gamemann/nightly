import { readFileSync } from "node:fs"
import path from "node:path"
import { db } from "~/server/db"
import { toolViewer } from "~/server/toolsServer"

export const dynamic = "force-dynamic"

// GET /api/tools/map-convert/<job id>/<output file>: a finished job's result file (only names the job lists as outputs).
export async function GET(req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
    const auth = await toolViewer(req, "tools.view")
    if ("deny" in auth) return auth.deny
    const { id, file } = await params
    if (!/^\d+$/.test(id)) return new Response("bad request", { status: 400 })
    const name = path.basename(decodeURIComponent(file))
    const rows = await db.$queryRawUnsafe<{ outputs: string }[]>("SELECT outputs FROM map_convert_job WHERE id = ?", Number(id)).catch(() => [])
    const listed = rows[0] ? (JSON.parse(rows[0].outputs) as { name: string }[]) : []
    const dir = process.env.NIGHTLY_MAPCONVERT_DIR || path.join(process.cwd(), "data", "map-convert")
    if (!listed.some((o) => o.name === name)) return new Response("not found", { status: 404 })
    const buf = readFileSync(path.join(dir, id, "out", name))
    return new Response(new Uint8Array(buf), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"`, "content-length": String(buf.length) } })
}
