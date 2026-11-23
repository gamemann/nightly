import { MapManager } from "~/components/tools/MapManager"
import { MapsList } from "~/components/MapsList"
import { mapRows } from "~/server/mapsList"
import AssetsPage from "../../assets/[[...slug]]/page"

export const dynamic = "force-dynamic"

/** /maps: the list of every map; /maps/<id>: the map page (the asset page with the fly-cam viewer). */
export default async function MapsPage({ params, searchParams }: { params: Promise<{ slug?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const { slug = [] } = await params
    if (slug[0]) return AssetsPage({ params: Promise.resolve({ slug: [slug[0]] }), searchParams })
    return <MapManager><MapsList rows={await mapRows()} /></MapManager>
}
