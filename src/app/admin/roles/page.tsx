import { AdminRoles } from '~/components/admin/Roles'
import { guard } from '~/server/pageGuard'

export default async function RolesPage() {
    const no = await guard('admin.roles')
    if (no) return no
    return <AdminRoles />
}
