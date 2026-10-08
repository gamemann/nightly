import { ItemDetail } from '~/components/ItemDetail'

export default async function ItemPage({ params }: { params: Promise<{ key: string }> }) {
    // Keyed, so going from one item to another starts fresh rather than carrying the last one's editor state over.
    const key = decodeURIComponent((await params).key)
    return <ItemDetail key={key} itemKey={key} />
}
