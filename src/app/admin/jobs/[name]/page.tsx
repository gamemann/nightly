import { Prompts } from '~/components/Prompts'
import { guard } from '~/server/pageGuard'

export default async function JobPage({ params }: { params: Promise<{ name: string }> }) {
    const no = await guard('admin.jobs')
    if (no) return no
    return <Prompts kind="script" name={decodeURIComponent((await params).name)} />
}
