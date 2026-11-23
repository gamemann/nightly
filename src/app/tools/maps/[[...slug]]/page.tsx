import { MapsList } from "~/components/MapsList"
import { mapRows } from "~/server/mapsList"
import AssetsPage from "../../(asset-manager)/assets/[[...slug]]/page"
import { guard } from '~/server/pageGuard'

export const dynamic = "force-dynamic"

/** /maps: the list of every map; /maps/<id>: the map page (the asset page with the fly-cam viewer). */
export default async function MapsPage({ params, searchParams }: { params: Promise<{ slug?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const no = await guard('tools.view')
    if (no) return no
    const { slug = [] } = await params
    if (slug[0]) return AssetsPage({ params: Promise.resolve({ slug: [slug[0]] }), searchParams })
    return <MapsList rows={await mapRows()} />
}
