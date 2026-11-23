import { trustedPost } from "~/server/auth"
import { assetsIngest } from "~/server/assetsServer"

// Asset audit ingest: POST the audit.json of tools/rsi_asset_audit.py (schema rsi-assets/2 (assets[]; the older weapons[] is accepted)) as the body.
//   curl -X POST -H "Authorization: Bearer nps_..." --data-binary @audit.json "$PANEL/api/assets/ingest"
// Same auth as /api/perf/ingest: panel cookie, or an ingest token (`nightly perf token add`); once any token exists one is required.
// Viewer glbs are read from NIGHTLY_ASSETS_DIR or the registered source roots by relative path.
export async function POST(req: Request) {
    const body = await req.text()
    if (!body.trim()) return Response.json({ error: "empty body" }, { status: 400 })
    const bearer = /^Bearer\s+(\S+)/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? ""
    // Signed in, or ingest left open: a token is checked only if one exists. Otherwise the proxy let this through for its Bearer token, which must be real.
    const viaCookie = await trustedPost(req)
    try {
        return Response.json(JSON.parse(await assetsIngest(body, bearer, viaCookie)))
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 422 })
    }
}
