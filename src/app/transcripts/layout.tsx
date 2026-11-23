import { Shell } from '~/components/transcripts/Shell'
import { guard } from '~/server/pageGuard'

export default async function Layout({ children }: { children: React.ReactNode }) {
    const no = await guard('transcripts.view')
    if (no) return no
    return <Shell>{children}</Shell>
}
