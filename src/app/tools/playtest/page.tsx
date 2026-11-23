import { Playtests } from '~/components/Feeds'
import { PlaytestPage } from '~/components/tools/PlaytestPage'
import { guard } from '~/server/pageGuard'

/** /tools/playtest[?game=]: trigger a playtest, follow its job, see playtests linked to perf runs; the full playtest feed below. */
export default async function Page({ searchParams }: { searchParams: Promise<{ game?: string }> }) {
    const no = await guard('tools.view')
    if (no) return no
    const { game } = await searchParams
    return <><PlaytestPage game={game} /><Playtests /></>
}
