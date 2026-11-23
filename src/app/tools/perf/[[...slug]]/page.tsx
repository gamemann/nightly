import { Perf } from "~/components/Perf"
import { guard } from '~/server/pageGuard'

export default async function PerfPage({ params }: { params: Promise<{ slug?: string[] }> }) {
    const no = await guard('tools.view')
    if (no) return no
    const { slug = [] } = await params
    return <Perf slug={slug} />
}
