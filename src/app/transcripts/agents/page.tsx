import { Agents } from '~/components/Agents'
import { AgentsView } from '~/components/transcripts/AgentsView'
import { guard } from '~/server/pageGuard'

export default async function AgentsPage() {
    const no = await guard('agents.view')
    if (no) return no
    return (
        <div className="h-full overflow-auto">
            <Agents />
            <AgentsView embedded />
        </div>
    )
}
