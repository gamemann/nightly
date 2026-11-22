import { COOKIE, readAuth, safeEqual, sessionToken } from "~/server/auth"
import { feedIngest } from "~/server/feedRouter"

// Health-feed ingest: POST one JSON record or an array to /api/ingest/<kind>, kind = releases | crashes | web | playtests | content
// (singular and `deploys` / `feedback` work too). Same Bearer token as perf ingest (`nightly perf token add`); once any token exists a request needs one.
//   curl -X POST -H "Authorization: Bearer nps_..." -d '{"game":"g","metric":"bundle_kb","value":4120}' "$PANEL/api/ingest/web"
// The write is `bin/nightly feed add <kind> -`: validation, upserts and findings live there. The answer is that command's JSON.
export async function POST(req: Request, ctx: { params: Promise<{ kind: string }> }) {
    const { kind } = await ctx.params
    const body = await req.text()
    if (!body.trim()) return Response.json({ error: "empty body" }, { status: 400 })
    const bearer = /^Bearer\s+(\S+)/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? ""
    const cfg = await readAuth()
    const viaCookie = !cfg.enabled || safeEqual(req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`))?.[1] ?? "", sessionToken(cfg))
    try {
        return Response.json(JSON.parse(await feedIngest(kind, body, bearer, viaCookie)))
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 422 })
    }
}
