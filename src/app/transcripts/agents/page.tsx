import { Agents } from '~/components/Agents'
import { guard } from '~/server/pageGuard'

export default async function AgentsPage() {
    const no = await guard('agents.view')
    if (no) return no
    return <Agents />
}
