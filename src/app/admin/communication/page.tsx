import { Communication } from '~/components/Communication'
import { guard } from '~/server/pageGuard'

export default async function CommunicationPage() {
    const no = await guard('admin.comm')
    if (no) return no
    return <Communication />
}
