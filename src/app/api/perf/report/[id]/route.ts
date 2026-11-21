import { perfReport } from "~/server/perfRouter"

// The per-run perf report for READMEs and PRs: /api/perf/report/<runId>?format=md (default) | svg | png. Behind the panel password like the rest of the tab.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const format = new URL(req.url).searchParams.get("format") ?? "md"
    if (!/^\d+$/.test(id) || !["md", "svg", "png"].includes(format)) return Response.json({ error: "usage: /api/perf/report/<runId>?format=md|svg|png" }, { status: 400 })
    try {
        const body = await perfReport(Number(id), format as "md" | "svg" | "png")
        const type = format === "md" ? "text/markdown; charset=utf-8" : format === "svg" ? "image/svg+xml" : "image/png"
        return new Response(new Uint8Array(body), { headers: { "content-type": type } })
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 404 })
    }
}
