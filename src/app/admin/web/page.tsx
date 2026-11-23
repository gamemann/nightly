import { Web } from "~/components/Feeds"
import { guard } from '~/server/pageGuard'

export default async function Page() {
    const no = await guard('admin.web')
    if (no) return no
    return <Web />
}
