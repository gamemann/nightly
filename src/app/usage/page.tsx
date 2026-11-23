import { Usage } from "~/components/Usage"
import { guard } from '~/server/pageGuard'

export default async function UsagePage() {
    const no = await guard('usage.view')
    if (no) return no
    return <Usage />
}
