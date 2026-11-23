import { RsiPage } from "~/components/RsiPage"
import { parsePage } from "~/lib/paging"
import { RSI_SPEC, loadRsiPage } from "~/server/rsiPage"
import { guard } from '~/server/pageGuard'

export const dynamic = "force-dynamic"

/** The RSI findings of the audited assets (models, maps, animations, textures, sounds), server-paged like `nightly rsi board`. */
export default async function Rsi({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const no = await guard('tools.view')
    if (no) return no
    const sp = await searchParams
    const tier = Array.isArray(sp.tier) ? sp.tier[0] : sp.tier
    const q = parsePage(sp, RSI_SPEC)
    return <RsiPage d={await loadRsiPage(tier, q)} q={q} />
}
