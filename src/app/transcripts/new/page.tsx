import { NewChat } from '~/components/transcripts/NewChat'
import { guard } from '~/server/pageGuard'

export default async function NewTranscriptPage() {
    const no = await guard('transcripts.run')
    if (no) return no
    return <NewChat />
}
