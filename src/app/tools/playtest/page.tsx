import { Playtests } from "~/components/Feeds"
import { guard } from '~/server/pageGuard'

export default async function Page() {
    const no = await guard('tools.view')
    if (no) return no
    return <Playtests />
}
