import { Builds } from '~/components/Builds'
import { guard } from '~/server/pageGuard'

export default async function BuildsPage() {
    const no = await guard('admin.builds')
    if (no) return no
    return <Builds />
}
