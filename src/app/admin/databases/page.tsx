import { Databases } from '~/components/Databases'
import { guard } from '~/server/pageGuard'

export default async function DatabasesPage() {
    const no = await guard('admin.databases')
    if (no) return no
    return <Databases />
}
