import { Releases } from '~/components/Feeds'
import { Workflows } from '~/components/automation/Workflows'
import { guard } from '~/server/pageGuard'

/** CI runs per accessible project, then the release feed. */
export default async function WorkflowsPage() {
    const no = await guard('automation.view')
    if (no) return no
    return <><Workflows /><Releases /></>
}
