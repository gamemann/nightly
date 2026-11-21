import { Perf } from "~/components/Perf"

export default async function PerfPage({ params }: { params: Promise<{ slug?: string[] }> }) {
    const { slug = [] } = await params
    return <Perf slug={slug} />
}
