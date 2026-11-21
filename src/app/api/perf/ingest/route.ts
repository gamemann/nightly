import { perfIngest } from "~/server/perfRouter"

// Performance ingest: POST a dot-profiler report (JSON v1/v2), a .folded stack file or the .txt summary as the body.
//   curl -X POST --data-binary @report.json "$PANEL/api/perf/ingest?game=fc&platform=native&role=client&map=arena&bots=4&commit=abc123"
// `name=x.folded` tells the parser the format when the body alone is ambiguous. Same optional password as the rest of the panel (proxy.ts).
// The write itself is `bin/nightly perf ingest -` (budgets, findings, size limits live there). The answer is that command's JSON.
const FLAGS = ["game", "platform", "role", "map", "bots", "commit", "gpu", "resolution", "label", "build", "branch", "at", "duration", "name"]

export async function POST(req: Request) {
    const url = new URL(req.url)
    const game = url.searchParams.get("game")
    if (!game) return Response.json({ error: "game is required (register it first: nightly perf game add, or ?register=1)" }, { status: 400 })
    const body = await req.text()
    if (!body.trim()) return Response.json({ error: "empty body" }, { status: 400 })
    const args: string[] = []
    for (const k of FLAGS) {
        const v = url.searchParams.get(k)
        if (v) args.push(`--${k}`, v)
    }
    if (url.searchParams.get("register")) args.push("--register")
    if (url.searchParams.get("noFindings")) args.push("--no-findings")
    args.push("--source", "http")
    try {
        return Response.json(JSON.parse(await perfIngest(args, body)))
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 422 })
    }
}
