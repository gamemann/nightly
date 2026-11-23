import { notFound, redirect } from 'next/navigation'
import { db } from '~/server/db'
import { guard } from '~/server/pageGuard'

// /transcripts/session/<Claude Code session id>: opens that session's main transcript (Usage links here).
// The transcript page itself checks who may read it.
export default async function Page({ params }: { params: Promise<{ sid: string }> }) {
    const no = await guard('transcripts.view')
    if (no) return no
    const { sid } = await params
    if (!/^[\w-]{6,80}$/.test(sid)) notFound()
    const t = await db.transcript.findFirst({ where: { sessionId: sid }, orderBy: [{ agentId: 'asc' }, { id: 'asc' }], select: { id: true } })
    if (!t) notFound()
    redirect(`/transcripts/${t.id}`)
}
