'use client'
import { Page } from '~/components/ui/Page'
import { PlaytestPanel } from './PlaytestPanel'
import { TOOLS_TABS } from './tabs'

export function PlaytestPage({ game }: { game?: string }) {
    return <Page title="Playtest" tabs={TOOLS_TABS} hint="Trigger bot playtests, follow their jobs and see the linked perf runs."><PlaytestPanel project={game} /></Page>
}
