'use client'
import { useRouter } from 'next/navigation'
import { api } from '~/trpc/react'
import { Legend, Panel, StackedBars, StatTile } from './Charts'
import { RUN_STATES, fmtUsd, statusByDay, successRate } from '../../lib/charts.mjs'

const DAYS = 14
const VIEWS = [
    { key: 'queue', label: 'Queued', href: '/tasks/queue' },
    { key: 'in_progress', label: 'In progress', href: '/tasks/in-progress' },
    { key: 'review', label: 'In review', href: '/tasks/review' },
    { key: 'blocked', label: 'Blocked', href: '/tasks/blocked' },
    { key: 'issues', label: 'Issues', href: '/tasks/issues' },
]

/** Item counts and recent run outcomes: the live numbers behind the Settings and Home pages. */
/** `runsLink`: link the tiles and bars to /admin/runs; only for viewers with admin.runs. */
export function OverviewStats({ title = 'Last two weeks', runsLink = false }: { title?: string; runsLink?: boolean }) {
    const router = useRouter()
    const runs = api.run.chart.useQuery({ days: DAYS }, { refetchInterval: 60_000 })
    const counts = api.item.counts.useQuery(undefined, { refetchInterval: 60_000 })
    const rows = runs.data?.runs ?? []
    const now = Date.now()
    const days = statusByDay(rows, { days: DAYS, now })
    const recent = rows.filter((r) => Date.parse(String(r.startedAt)) >= now - DAYS * 86_400_000)
    const rate = successRate(recent)
    const cost = recent.reduce((n, r) => n + (r.costUsd ?? 0), 0)
    const tot = (k: string) => days.reduce((n, d) => n + (d.segments[k] ?? 0), 0)
    return (
        <section aria-label={title} className="mb-5 grid gap-3 lg:grid-cols-3">
            <div className="grid grid-cols-2 gap-3 content-start sm:grid-cols-3 lg:col-span-3 lg:grid-cols-5">
                {VIEWS.map((v) => <StatTile key={v.key} label={v.label} value={counts.data?.[v.key as 'queue'] ?? '-'} note="items" href={v.href} />)}
            </div>
            <div className="lg:col-span-2">
                <Panel title="Runs by day" subtitle={`Outcome of every run per day (UTC), last ${DAYS} days.${runsLink ? ' Click a day to open its newest run.' : ''}`} empty={!runs.isLoading && recent.length === 0 && `No runs in the last ${DAYS} days.`}
                    legend={<Legend items={RUN_STATES.filter((s) => tot(s.key) > 0).map((s) => ({ label: s.label, color: s.color, count: tot(s.key) }))} />}>
                    <StackedBars ariaLabel="Runs per day by status" unit="runs" height={90}
                        bars={days.map((d) => ({ key: d.key, label: d.key.slice(5), id: d.ids[0], segments: RUN_STATES.map((s) => ({ key: s.key, label: s.label, value: d.segments[s.key], color: s.color })) }))}
                        onBar={(b) => runsLink && b.id != null && router.push(`/admin/runs/${Math.max(...days.find((d) => d.key === b.key)!.ids)}`)} />
                </Panel>
            </div>
            <div className="grid grid-cols-2 gap-3 content-start">
                <StatTile label="Completed" value={rate == null ? '-' : `${Math.round(rate * 100)}%`} note={`of ${recent.filter((r) => r.status !== 'running').length} runs`} href={runsLink ? '/admin/runs' : undefined} />
                <StatTile label="Cost" value={fmtUsd(cost)} note={`${DAYS} days, USD`} href={runsLink ? '/admin/runs' : undefined} />
            </div>
        </section>
    )
}
