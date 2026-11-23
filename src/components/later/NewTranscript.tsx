import { Scaffold } from '~/components/shell/ui'

// EXTENSION POINT (phase 2): start an agent transcript (pick a project, a node and a prompt, then
// stream the session here). Needs transcripts.run.
export function NewTranscript() {
    return (
        <Scaffold title="New transcript" phase={2} links={[['/transcripts', 'History'], ['/transcripts/agents', 'Agents']]}>
            Start an agent on a project from here: choose the project, the node it runs on and a prompt, and follow it live.
        </Scaffold>
    )
}
