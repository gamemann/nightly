import { trustedPost } from "~/server/auth"
import { agentHeartbeat } from "~/server/feedRouter"

// Agent heartbeat: any runner (a fleet launcher, a CI job, a subagent wrapper) registers or refreshes itself on the board.
//   curl -X POST -H "Authorization: Bearer nps_..." -d '{"name":"worker-3","task":"fix X","kind":"session","repos":"a,b"}' "$PANEL/api/agents/heartbeat"
// {"name":"worker-3","leave":true} takes it off the board. Silent agents turn stale after an hour and leave after the agentLeftHours setting (12).
// Same Bearer token as perf ingest (`nightly perf token add`). The write is `bin/nightly agent heartbeat`.
export async function POST(req: Request) {
    let b: Record<string, unknown>
    try { b = await req.json() } catch { return Response.json({ error: "body is not JSON" }, { status: 400 }) }
    const name = typeof b.name === "string" ? b.name : ""
    if (!name) return Response.json({ error: "name is required" }, { status: 400 })
    const bearer = /^Bearer\s+(\S+)/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? ""
    // Signed in, or ingest left open: a token is checked only if one exists. Otherwise the proxy let this through for its Bearer token, which must be real.
    const viaCookie = await trustedPost(req)
    const args = ["agent", "heartbeat", name, "--json", viaCookie ? "--require-token" : "--token-only"]
    for (const k of ["task", "kind", "repos", "note"]) if (typeof b[k] === "string" && b[k]) args.push(`--${k}`, b[k] as string)
    if (b.leave === true) args.push("--leave")
    try {
        return Response.json(JSON.parse(await agentHeartbeat(args, bearer)))
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 422 })
    }
}
