import { Suspense } from 'react'
import { RunList } from '~/components/Runs'

export default function RunsPage() {
    return <Suspense><RunList /></Suspense>
}
