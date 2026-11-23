import { CrashLog } from '~/components/admin/CrashLog'
import { guard } from '~/server/pageGuard'

export default async function CrashLogPage() {
    const no = await guard('admin.crashlog')
    if (no) return no
    return <CrashLog />
}
