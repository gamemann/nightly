import { Releases } from '~/components/Feeds'
import { WorkflowsPanel } from '~/components/later/Workflows'
import { guard } from '~/server/pageGuard'

export default async function WorkflowsPage() {
    const no = await guard('automation.view')
    if (no) return no
    return <><WorkflowsPanel /><Releases /></>
}
