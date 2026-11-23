import { Scaffold } from '~/components/shell/ui'

// EXTENSION POINT (phase 3): communication channels (chat webhooks, mail) and which events go where.
// Channel secrets are stored as a secretRef (an env var or file name), never the value. Needs admin.comm.
export function Communication() {
    return (
        <Scaffold title="Communication" phase={3}>
            Channels for notifications: where finished runs, failed checks, blocked tasks and crashes are announced.
        </Scaffold>
    )
}
