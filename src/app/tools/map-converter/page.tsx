import { MapConverter } from '~/components/tools/MapConverter'
import { guard } from '~/server/pageGuard'

export const dynamic = 'force-dynamic'

/** /tools/map-converter?project=<slug>: the Map Converter (job based; BSP, VMF, Quake .map, GameSpice map, glTF). */
export default async function MapConverterPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
    const no = await guard('tools.view')
    if (no) return no
    const { project } = await searchParams
    return <MapConverter projectSlug={project} />
}
