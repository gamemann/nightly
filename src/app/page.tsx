import { RsiBoard } from "~/components/RsiBoard"
import { parsePage } from "~/lib/paging"
import { BLOCKER_SPEC, FINDING_SPEC, WORST_SPEC, loadBoard } from "~/server/rsiBoard"
import { redirect } from 'next/navigation'
import { allowed } from '~/lib/nav'
import { getViewer } from '~/server/auth'

export const dynamic = "force-dynamic"

/** Home: the RSI board (findings per domain, worst assets, blockers). The findings table is paged, sorted, filtered and searched in SQL. */
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    // Home is the RSI board; someone without the game tools starts at their projects.
    const v = await getViewer()
    if (!v || !allowed(v.perms, 'tools.view')) redirect('/projects')
    const sp = await searchParams
    const tier = Array.isArray(sp.tier) ? sp.tier[0] : sp.tier
    const q = parsePage(sp, FINDING_SPEC)
    const bq = parsePage(sp, BLOCKER_SPEC, "b")
    const wq = parsePage(sp, WORST_SPEC, "w")
    return <RsiBoard b={await loadBoard(tier, q, bq, wq)} q={q} bq={bq} wq={wq} runsLink={allowed(v.perms, 'admin.runs')} />
}
