import { Scaffold } from '~/components/shell/ui'

// EXTENSION POINT (phase 4): the workspace crash log (panel, runner and node crashes, as opposed to
// the game crashes under Game Tools > Crashes). Needs admin.crashlog.
export function CrashLog() {
    return (
        <Scaffold title="Crash Log" phase={4} links={[['/tools/crashes', 'Game crashes'], ['/admin/runs', 'Runs & reports']]}>
            Crashes of the panel, the scheduler and the nodes will be listed here with their stack and the run they broke.
        </Scaffold>
    )
}
