import { GithubUsage } from '~/components/usage/GithubUsage'
import { guard } from '~/server/pageGuard'

export default async function GithubUsagePage() {
    const no = await guard('usage.view')
    if (no) return no
    return <GithubUsage />
}
