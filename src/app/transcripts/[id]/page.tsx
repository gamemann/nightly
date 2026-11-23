import { notFound } from 'next/navigation'
import { Chat } from '~/components/transcripts/Chat'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    if (!/^\d+$/.test(id)) notFound()
    return <Chat key={id} id={Number(id)} />
}
