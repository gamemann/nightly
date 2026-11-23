import { trustedPost } from "~/server/auth"
import { safeEqual } from "../../../../../lib/passwords.mjs"
import { usageIngest } from "~/server/usageRouter"

// POST (no body needed) re-reads the configured transcript dirs incrementally and pushes to ClickHouse when enabled.
//   curl -X POST "$PANEL/api/usage/ingest"            # ?full=1 re-reads every file from the start
// A signed-in session (or the ingestOpen setting), or `Authorization: Bearer $NIGHTLY_USAGE_TOKEN`
// for a cron job. With no token configured only a session (or ingestOpen) is accepted. The answer is `nightly usage ingest --json`.
export async function POST(req: Request) {
    if (!(await trustedPost(req))) {
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
