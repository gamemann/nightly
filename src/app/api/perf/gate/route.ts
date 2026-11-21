import { COOKIE, readAuth, safeEqual, sessionToken } from "~/server/auth"
import { perfGate } from "~/server/perfRouter"

// CI perf gate: GET or POST /api/perf/gate?game=fc&run=latest|<id>|<commit>[&platform=&role=&map=&bots=][&budgets=0][&baseline=0][&noisePct=&sigma=&minRuns=&runs=]
// Answers 200 {pass:true,...} or 422 {pass:false,failures:[...]} (so `curl -f` fails the job), 404 when no run matches. Same auth as ingest:
// "Authorization: Bearer nps_..." (a token from `nightly perf token add`) or the panel session. See README, "Perf gate in CI".
const FLAGS: Record<string, string> = { platform: "platform", role: "role", map: "map", bots: "bots", noisePct: "noise-pct", sigma: "sigma", minRuns: "min-runs", runs: "runs" }

async function handle(req: Request) {
    const url = new URL(req.url)
    const game = url.searchParams.get("game")
    if (!game) return Response.json({ error: "game is required" }, { status: 400 })
    const bearer = /^Bearer\s+(\S+)/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? ""
    const cfg = await readAuth()
    const viaCookie = !cfg.enabled || safeEqual(req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`))?.[1] ?? "", sessionToken(cfg))
    const args = ["--game", game, "--run", url.searchParams.get("run") || "latest"]
    for (const [q, f] of Object.entries(FLAGS)) { const v = url.searchParams.get(q); if (v) args.push(`--${f}`, v) }
    if (url.searchParams.get("budgets") === "0") args.push("--no-budgets")
    if (url.searchParams.get("baseline") === "0") args.push("--no-baseline")
    args.push(viaCookie ? "--require-token" : "--token-only")
    const r = await perfGate(args, bearer)
    return Response.json(r.body, { status: r.status })
}
export const GET = handle
export const POST = handle
