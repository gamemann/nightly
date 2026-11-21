import { COOKIE, readAuth, safeEqual, sessionToken } from "~/server/auth"
import { perfShot } from "~/server/perfRouter"

// Attach a screenshot to a run: POST /api/perf/shot?run=<id>[&name=worst-hitch][&note=...] with the png as the body (or multipart part `file`).
// Auth as ingest (Bearer token or panel session). The size limit is the setting perfMaxShotBytes (0 = unlimited); more than perfMaxShotsPerRun per run is refused.
export async function POST(req: Request) {
    const url = new URL(req.url)
    const run = url.searchParams.get("run")
    if (!run || !/^\d+$/.test(run)) return Response.json({ error: "run=<id> is required" }, { status: 400 })
    let png: Buffer
    if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
        const f = (await req.formData()).get("file")
        if (!f || typeof f === "string") return Response.json({ error: "multipart part `file` is required" }, { status: 400 })
        png = Buffer.from(await f.arrayBuffer())
    } else png = Buffer.from(await req.arrayBuffer())
    if (!png.length) return Response.json({ error: "empty body" }, { status: 400 })
    const bearer = /^Bearer\s+(\S+)/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? ""
    const cfg = await readAuth()
    const viaCookie = !cfg.enabled || safeEqual(req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`))?.[1] ?? "", sessionToken(cfg))
    const args = ["--run", run, ...(url.searchParams.get("name") ? ["--name", url.searchParams.get("name")!] : []), ...(url.searchParams.get("note") ? ["--note", url.searchParams.get("note")!] : []), viaCookie ? "--require-token" : "--token-only"]
    try {
        return Response.json(JSON.parse(await perfShot(args, png, bearer)))
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 422 })
    }
}
