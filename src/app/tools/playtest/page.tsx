'use client'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { Page } from '~/components/ui/Page'
import { PlaytestPanel } from '~/components/tools/PlaytestPanel'
import { TOOLS_TABS } from '~/components/tools/tabs'

function Inner() {
    const game = useSearchParams().get('game') ?? undefined
    return <Page title="Playtest" tabs={TOOLS_TABS} hint="Trigger bot playtests, follow their jobs and see the linked perf runs."><PlaytestPanel project={game} /></Page>
}
export default function PlaytestPage() {
    return <Suspense><Inner /></Suspense>
}
