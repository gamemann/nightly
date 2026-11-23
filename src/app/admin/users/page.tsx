import { AdminUsers } from '~/components/admin/Users'
import { guard } from '~/server/pageGuard'

export default async function UsersPage() {
    const no = await guard('admin.users')
    if (no) return no
    return <AdminUsers />
}
