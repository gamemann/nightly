import { Suspense } from 'react'
import { RunList } from '~/components/Runs'
import { guard } from '~/server/pageGuard'

export default async function RunsPage() {
    const no = await guard('admin.runs')
    if (no) return no
    return <Suspense><RunList /></Suspense>
}
