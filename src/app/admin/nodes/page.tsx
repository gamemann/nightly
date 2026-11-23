import { Nodes } from '~/components/Nodes'
import { guard } from '~/server/pageGuard'

export default async function NodesPage() {
    const no = await guard('admin.nodes')
    if (no) return no
    return <Nodes />
}
