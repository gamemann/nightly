'use client'
import Link from 'next/link'
import { GameView } from '../Perf'

/** Project tab: the game's performance view (trends, runs, offenders, findings, budgets), linked to its playtests. */
export function PerfTab({ projectSlug }: { projectSlug: string }) {
    return (
        <div>
            <div className="mb-2 text-[12px] text-muted">Each bot perf run has a linked automatic playtest. <Link className="text-accent hover:underline" href={`/tools/playtest?game=${projectSlug}`}>Playtests and trigger</Link></div>
            <GameView slug={projectSlug} />
        </div>
    )
}
