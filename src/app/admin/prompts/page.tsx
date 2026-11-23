import { Prompts } from '~/components/Prompts'
import { guard } from '~/server/pageGuard'

export default async function PromptsPage() {
    const no = await guard('admin.prompts')
    if (no) return no
    return <Prompts />
}
