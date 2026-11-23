'use client'
import { PlaytestPanel } from './PlaytestPanel'

/** Project tab: playtests of one project (its slug is its game slug), with the trigger form. */
export function PlaytestTab({ projectSlug }: { projectSlug: string }) {
    return <PlaytestPanel project={projectSlug} />
}
