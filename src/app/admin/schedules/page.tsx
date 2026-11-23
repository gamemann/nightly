import { Suspense } from 'react'
import { Schedules } from '~/components/Schedules'
import { guard } from '~/server/pageGuard'

export default async function SchedulesPage() {
    const no = await guard('admin.schedules')
    if (no) return no
    return <Suspense><Schedules /></Suspense>
}
