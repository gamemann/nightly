import { trustedPost } from "~/server/auth"
import { perfIngest } from "~/server/perfRouter"

// Performance ingest: POST a gs-profiler report (JSON v1/v2), a .folded stack file or the .txt summary as the body.
//   curl -X POST --data-binary @report.json "$PANEL/api/perf/ingest?game=fc&platform=native&role=client&map=arena&bots=4&commit=abc123"
// `name=x.folded` tells the parser the format when the body alone is ambiguous. Same optional password as the rest of the panel (proxy.ts).
// With `Authorization: Bearer nps_...` (a token from `nightly perf token add`; per runner or per game, stored hashed) a runner can post even when the
// panel login is on. Once any token exists, ingest without a valid one is refused. A v1 report plus its stacks: multipart with parts `report` and `folded`,
// or JSON {"report": {...}, "folded": "a;b 12\n..."}; a bare v1 report may also embed its stacks (`folded` / `stacks`).
// The write itself is `bin/nightly perf ingest -` (budgets, findings, size limits live there). The answer is that command's JSON.
const FLAGS = ["game", "platform", "role", "map", "bots", "commit", "gpu", "resolution", "label", "build", "branch", "at", "duration", "name"]

export async function POST(req: Request) {
    const url = new URL(req.url)
    const game = url.searchParams.get("game")
    if (!game) return Response.json({ error: "game is required (register it first: nightly perf game add, or ?register=1)" }, { status: 400 })
    let body: string
    const ctype = req.headers.get("content-type") ?? ""
    if (ctype.startsWith("multipart/form-data")) {
        const form = await req.formData()
        const part = async (k: string) => { const v = form.get(k); return v == null ? "" : typeof v === "string" ? v : await v.text() }
        const report = await part("report")
        const folded = await part("folded")
        body = folded ? JSON.stringify({ report, folded }) : report
    } else body = await req.text()
    const bearer = /^Bearer\s+(\S+)/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? ""
        // Signed in, or ingest left open: a token is checked only if one exists. Otherwise the proxy let this through for its Bearer token, which must be real.
    const viaCookie = await trustedPost(req)
    if (!body.trim()) return Response.json({ error: "empty body" }, { status: 400 })
    const args: string[] = []
    for (const k of FLAGS) {
        const v = url.searchParams.get(k)
        if (v) args.push(`--${k}`, v)
    }
    if (url.searchParams.get("register")) args.push("--register")
    if (url.searchParams.get("noFindings")) args.push("--no-findings")
    args.push("--source", "http", viaCookie ? "--require-token" : "--token-only")
    try {
        return Response.json(JSON.parse(await perfIngest(args, body, bearer)))
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 422 })
    }
}
