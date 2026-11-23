import { Scaffold } from '~/components/shell/ui'

// EXTENSION POINT (phase 3): workflows (multi-step automations: build, test, release, notify),
// edited per project and run on nodes. Replace this component; the page and nav already exist.
export function WorkflowsPanel() {
    return (
        <Scaffold title="Workflows" phase={3} links={[['/automation/checks', 'Checks'], ['/admin/schedules', 'Schedules']]}>
            Workflows chain builds, tests, releases and notifications per project. Until they land, the release feed below
            shows what each project has shipped.
        </Scaffold>
    )
}
