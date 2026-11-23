import { Checks } from '~/components/automation/Checks'
import { guard } from '~/server/pageGuard'

/** Script checks (scripts/chk-*.sh on an interval) and item checks (kind=check, done by an agent). */
export default async function ChecksPage() {
    const no = await guard('automation.view')
    if (no) return no
    return <Checks />
}
