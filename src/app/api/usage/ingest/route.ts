import { COOKIE, readAuth, safeEqual, sessionToken } from "~/server/auth"
import { usageIngest } from "~/server/usageRouter"

// POST (no body needed) re-reads the configured transcript dirs incrementally and pushes to ClickHouse when enabled.
//   curl -X POST "$PANEL/api/usage/ingest"            # ?full=1 re-reads every file from the start
// Same optional panel password as the rest of the panel (proxy.ts): a valid session cookie, or `Authorization: Bearer $NIGHTLY_USAGE_TOKEN`
// for a cron job. With no token configured only the cookie (or no login at all) is accepted. The answer is `nightly usage ingest --json`.
export async function POST(req: Request) {
    const cfg = await readAuth()
    const cookie = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`))?.[1] ?? ""
    if (cfg.enabled && !safeEqual(cookie, sessionToken(cfg))) {
        const bearer = /^Bearer\s+(\S+)/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? ""
        const want = process.env.NIGHTLY_USAGE_TOKEN ?? ""
        if (!want || !safeEqual(bearer, want)) return Response.json({ error: "unauthorized (set NIGHTLY_USAGE_TOKEN to allow Bearer ingest)" }, { status: 401 })
    }
    try {
        return Response.json(await usageIngest(new URL(req.url).searchParams.get("full") ? ["--full"] : []))
    } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 422 })
    }
}
