import { ItemDetail } from '~/components/ItemDetail'
import { guard } from '~/server/pageGuard'

export default async function ItemPage({ params }: { params: Promise<{ key: string }> }) {
    const no = await guard('tasks.view')
    if (no) return no
    // Keyed, so going from one item to another starts fresh rather than carrying the last one's editor state over.
    const key = decodeURIComponent((await params).key)
    return <ItemDetail key={key} itemKey={key} />
}
