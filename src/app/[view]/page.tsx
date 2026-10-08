import { notFound } from 'next/navigation'
import { ItemList } from '~/components/ItemList'
import type { View } from '~/server/api'

const SLUGS: Record<string, View> = {
    queue: 'queue', 'in-progress': 'in_progress', review: 'review', blocked: 'blocked', issues: 'issues', checks: 'checks', done: 'done', all: 'all',
}

export default async function ViewPage({ params }: { params: Promise<{ view: string }> }) {
    const view = SLUGS[(await params).view]
    if (!view) notFound()
    return <ItemList view={view} />
}
