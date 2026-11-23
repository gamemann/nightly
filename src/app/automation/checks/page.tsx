import { Suspense } from 'react'
import { ItemList } from '~/components/ItemList'
import { guard } from '~/server/pageGuard'

/** Recurring checks (items of kind check), with their due state. */
export default async function ChecksPage() {
    const no = await guard(['automation.view', 'tasks.view'])
    if (no) return no
    return <Suspense><ItemList view="checks" /></Suspense>
}
