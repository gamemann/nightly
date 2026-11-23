import { notFound } from 'next/navigation'
import { RunDetail } from '~/components/Runs'
import { guard } from '~/server/pageGuard'

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
    const no = await guard('admin.runs')
    if (no) return no
    const id = Number((await params).id)
    if (!Number.isInteger(id)) notFound()
    return <RunDetail id={id} />
}
