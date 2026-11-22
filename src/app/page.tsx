import { RsiBoard } from "~/components/RsiBoard"
import { parsePage } from "~/lib/paging"
import { FINDING_SPEC, loadBoard } from "~/server/rsiBoard"

export const dynamic = "force-dynamic"

/** Home: the RSI board (findings per domain, worst assets, blockers). The findings table is paged, sorted, filtered and searched in SQL. */
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const sp = await searchParams
    const tier = Array.isArray(sp.tier) ? sp.tier[0] : sp.tier
    const q = parsePage(sp, FINDING_SPEC)
    return <RsiBoard b={await loadBoard(tier, q)} q={q} />
}
