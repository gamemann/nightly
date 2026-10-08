'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { api } from '~/trpc/react'

const NAV = [
    { href: '/queue', label: 'Queue', count: 'queue', dot: 'bg-sky-400' },
    { href: '/in-progress', label: 'In progress', count: 'in_progress', dot: 'bg-amber-400' },
    { href: '/review', label: 'Review', count: 'review', dot: 'bg-violet-400' },
    { href: '/blocked', label: 'Blocked', count: 'blocked', dot: 'bg-red-400' },
    { href: '/issues', label: 'Issues', count: 'issues', dot: 'bg-rose-300' },
    { href: '/checks', label: 'Checks', count: 'checks', dot: 'bg-teal-300' },
    { href: '/done', label: 'Done', count: 'done', dot: 'bg-emerald-400' },
] as const

export function Sidebar() {
    const path = usePathname()
    const counts = api.item.counts.useQuery(undefined, { refetchInterval: 30_000 })
    const settings = api.setting.all.useQuery()
    const liveAgents = api.agent.liveCount.useQuery(undefined, { refetchInterval: 15_000 })
    const doRun = settings.data?.doRun === 'true'
    if (path === '/login') return null
    const link = (href: string, active: boolean) =>
        `flex items-center gap-2.5 rounded-md px-2.5 py-1.5 transition ${active ? 'bg-hover text-fg' : 'text-dim hover:bg-hover/60 hover:text-fg'}`
    return (
        <aside className="sticky top-0 flex h-screen w-52 shrink-0 flex-col border-r border-line bg-panel/60 px-2.5 py-3 max-md:w-14 max-md:px-1.5">
            <Link href="/queue" className="mb-4 flex items-center gap-2 px-2 text-[13px] font-semibold tracking-tight">
                <svg viewBox="0 0 32 32" className="size-5 shrink-0"><path d="M20.5 7.5a9 9 0 1 0 4 13.2A7.2 7.2 0 0 1 20.5 7.5Z" fill="#8b8cf8" /></svg>
                <span className="max-md:hidden">nightly</span>
            </Link>
            <nav className="flex flex-col gap-0.5">
                {NAV.map((n) => {
                    const c = counts.data?.[n.count]
                    return (
                        <Link key={n.href} href={n.href} className={link(n.href, path === n.href)} title={n.label}>
                            <span className={`size-2 shrink-0 rounded-full ${n.dot}`} />
                            <span className="flex-1 max-md:hidden">{n.label}</span>
                            {n.count === 'checks' && !!counts.data?.dueChecks && (
                                <span className="rounded bg-teal-400/15 px-1 text-[10px] text-teal-300 max-md:hidden">{counts.data.dueChecks} due</span>
                            )}
                            {c !== undefined && <span className="text-[11px] tabular-nums text-muted max-md:hidden">{c}</span>}
                        </Link>
                    )
                })}
            </nav>
            <div className="my-3 border-t border-line" />
            <nav className="flex flex-col gap-0.5">
                <Link href="/agents" className={link('/agents', path === '/agents')} title="Agents">
                    <span className={`size-2 shrink-0 rounded-full ${liveAgents.data ? 'bg-teal-400 shadow-[0_0_6px] shadow-teal-400' : 'bg-zinc-600'}`} />
                    <span className="flex-1 max-md:hidden">Agents</span>
                    {!!liveAgents.data && <span className="rounded bg-teal-400/15 px-1 text-[10px] text-teal-300 max-md:hidden">{liveAgents.data} live</span>}
                </Link>
                <Link href="/runs" className={link('/runs', path.startsWith('/runs'))} title="Runs & reports">
                    <span className="w-2 text-center text-[11px] text-muted">▸</span><span className="max-md:hidden">Runs &amp; reports</span>
                </Link>
                <Link href="/schedules" className={link('/schedules', path === '/schedules')} title="Schedules">
                    <span className="w-2 text-center text-[11px] text-muted">◷</span><span className="max-md:hidden">Schedules</span>
                </Link>
                <Link href="/prompts" className={link('/prompts', path.startsWith('/prompts'))} title="Prompts">
                    <span className="w-2 text-center text-[11px] text-muted">¶</span><span className="max-md:hidden">Prompts</span>
                </Link>
                <Link href="/settings" className={link('/settings', path === '/settings')} title="Settings">
                    <span className="w-2 text-center text-[11px] text-muted">⚙</span><span className="max-md:hidden">Settings</span>
                </Link>
            </nav>
            <div className="mt-auto px-2 text-[11px] text-muted max-md:hidden">
                {settings.data && (
                    <Link href="/schedules" className="flex items-center gap-1.5 hover:text-dim">
                        <span className={`size-1.5 rounded-full ${doRun ? 'bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400' : 'bg-zinc-600'}`} />
                        schedules {doRun ? 'live' : 'paused'}
                    </Link>
                )}
            </div>
        </aside>
    )
}
