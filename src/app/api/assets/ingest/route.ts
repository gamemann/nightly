import { COOKIE, readAuth, safeEqual, sessionToken } from "~/server/auth"
import { assetsIngest } from "~/server/assetsServer"

// Asset audit ingest: POST the audit.json of tools/rsi_asset_audit.py (schema rsi-assets/1) as the body.
//   curl -X POST -H "Authorization: Bearer nps_..." --data-binary @audit.json "$PANEL/api/assets/ingest"
// Same auth as /api/perf/ingest: panel cookie, or an ingest token (`nightly perf token add`); once any token exists one is required.
// Viewer glbs are read from NIGHTLY_ASSETS_DIR (default /home/gamedev/perf-bench/rsi-assets) by relative path.
export async function POST(req: Request) {
    const body = await req.text()
    if (!body.trim()) return Response.json({ error: "empty body" }, { status: 400 })
    const bearer = /^Bearer\s+(\S+)/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? ""
    const cfg = await readAuth()
    const viaCookie = !cfg.enabled || safeEqual(req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`))?.[1] ?? "", sessionToken(cfg))
    try {
        return Response.json(JSON.parse(await assetsIngest(body, bearer, viaCookie)))
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 422 })
    }
}
