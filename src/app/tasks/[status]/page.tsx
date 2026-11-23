import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { ItemList } from '~/components/ItemList'
import type { View } from '~/server/api'
import { guard } from '~/server/pageGuard'

// /tasks/<status>. Checks live under /automation/checks.
const SLUGS: Record<string, View> = {
    queue: 'queue', 'in-progress': 'in_progress', review: 'review', blocked: 'blocked', issues: 'issues', done: 'done', all: 'all',
}

export default async function TasksPage({ params }: { params: Promise<{ status: string }> }) {
    const view = SLUGS[(await params).status]
    if (!view) notFound()
    const no = await guard('tasks.view')
    if (no) return no
    return <Suspense><ItemList view={view} /></Suspense>
}
