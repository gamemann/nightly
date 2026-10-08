import { notFound } from 'next/navigation'
import { RunDetail } from '~/components/Runs'

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
    const id = Number((await params).id)
    if (!Number.isInteger(id)) notFound()
    return <RunDetail id={id} />
}
