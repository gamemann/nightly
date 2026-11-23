import { MapConverter } from '~/components/later/MapConverter'
import { guard } from '~/server/pageGuard'

export default async function MapConverterPage() {
    const no = await guard('tools.view')
    if (no) return no
    return <MapConverter />
}
