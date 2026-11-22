import { RsiBoard } from "~/components/RsiBoard"
import { loadBoard } from "~/server/rsiBoard"

export const dynamic = "force-dynamic"

/** Home: the RSI board (findings per domain, worst assets, blockers). The item lists live under /queue etc. */
export default async function Home({ searchParams }: { searchParams: Promise<{ tier?: string }> }) {
    const { tier } = await searchParams
    return <RsiBoard b={await loadBoard(tier)} />
}
