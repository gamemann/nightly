import { Settings } from '~/components/Settings'
import { guard } from '~/server/pageGuard'

export default async function SettingsPage() {
    const no = await guard('admin.settings')
    if (no) return no
    return <Settings />
}
