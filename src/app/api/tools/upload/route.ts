import { toolViewer, toolsCli, withTempFile } from "~/server/toolsServer"

export const dynamic = "force-dynamic"

// POST multipart: file, type? (model|texture|sound|animation|map|other), pack?, note?, project?, bin? (the .bin beside a GameSpice map .json).
// Validates (type, magic bytes, size limit from the settings uploadMaxMb[.type], 0 = unlimited), stores, converts and scans via `nightly assets upload`.
export async function POST(req: Request) {
    const auth = await toolViewer(req, "assets.upload")
    if ("deny" in auth) return auth.deny
    const form = await req.formData()
    const file = form.get("file")
    if (!(file instanceof File) || !file.size) return Response.json({ error: "no file in the upload" }, { status: 400 })
    const bin = form.get("bin")
    const s = (k: string) => { const v = form.get(k); return typeof v === "string" && v.trim() ? v.trim() : "" }
    try {
        const r = await withTempFile(file, async (p) => {
            const args = ["assets", "upload", p, "--by", auth.viewer.username]
            for (const k of ["type", "pack", "note", "project"]) if (s(k)) args.push(`--${k}`, s(k))
            if (bin instanceof File && bin.size) return withTempFile(bin, (bp) => toolsCli([...args, "--bin", bp]))
            return toolsCli(args)
        })
        return Response.json(r)
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 422 })
    }
}
