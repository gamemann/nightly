import { Prompts } from '~/components/Prompts'
import { guard } from '~/server/pageGuard'

export default async function PromptPage({ params }: { params: Promise<{ name: string }> }) {
    const no = await guard('admin.prompts')
    if (no) return no
    return <Prompts name={decodeURIComponent((await params).name)} />
}
