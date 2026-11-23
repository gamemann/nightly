import { Prompts } from '~/components/Prompts'
import { guard } from '~/server/pageGuard'

export default async function JobsPage() {
    const no = await guard('admin.jobs')
    if (no) return no
    return <Prompts kind="script" />
}
