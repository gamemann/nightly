'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { Perms } from '../../../lib/permissions.mjs'
import { allowed, isActive, visibleNav, type NavLink } from '~/lib/nav'
import { api } from '~/trpc/react'
import { Moon } from './Moon'

export type ShellViewer = { username: string; name: string; perms: Perms; admin: boolean }

const KEY = 'nightly.sidebar.collapsed'

/** The app's left rail: collapsible on desktop (remembered), an off-canvas drawer on phones. */
export function Sidebar({ viewer }: { viewer: ShellViewer }) {
    const path = usePathname() ?? '/'
    const [collapsed, setCollapsed] = useState(false)
    const [open, setOpen] = useState(false)
    useEffect(() => { setCollapsed(localStorage.getItem(KEY) === '1') }, [])
    useEffect(() => { setOpen(false) }, [path])
    const toggle = () => setCollapsed((c) => { localStorage.setItem(KEY, c ? '0' : '1'); return !c })

    const p = viewer.perms
    const counts = api.item.counts.useQuery(undefined, { refetchInterval: 30_000, enabled: allowed(p, 'tasks.view') })
    const live = api.agent.liveCount.useQuery(undefined, { refetchInterval: 15_000, enabled: allowed(p, 'agents.view') })
    const settings = api.setting.all.useQuery(undefined, { enabled: allowed(p, 'admin.schedules') })
    const folders = api.folder.list.useQuery(undefined, { staleTime: 60_000 })
    const nav = visibleNav(p)
    const c = collapsed && !open
    const doRun = settings.data?.doRun === 'true'

    const item = (l: NavLink, badge?: number | null) => (
        <Link key={l.href} href={l.href} title={l.label}
            className={`group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition ${isActive(path, l) ? 'nav-active text-fg' : 'text-dim hover:bg-hover/70 hover:text-fg'}`}>
            {l.dot ? <span className={`mx-1 size-2 shrink-0 rounded-full ${l.dot} shadow-[0_0_6px] shadow-current`} /> : <span className="w-4 shrink-0 text-center text-[13px] opacity-80">{l.icon}</span>}
            {!c && <span className="truncate">{l.label}</span>}
            {!c && badge != null && badge > 0 && <span className="ml-auto text-[11px] tabular-nums text-muted">{badge}</span>}
        </Link>
    )
    const title = (t: string, href?: string, extra?: React.ReactNode) => c ? <div className="mx-2 my-2 border-t border-line/60" /> : (
        <div className="mb-1 mt-4 flex items-center justify-between px-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
            {href ? <Link href={href} className="hover:text-fg">{t}</Link> : <span>{t}</span>}
            {extra}
        </div>
    )

    return (
        <>
            <button aria-label="Open menu" onClick={() => setOpen(true)} className="fixed left-3 top-3 z-40 grid size-9 place-items-center rounded-md border border-line bg-panel/90 text-dim md:hidden">☰</button>
            {open && <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={() => setOpen(false)} />}
            <aside className={`fixed inset-y-0 left-0 z-50 flex flex-col border-r border-line/70 bg-panel/80 backdrop-blur-md transition-all md:sticky md:top-0 md:h-screen md:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'} ${c ? 'w-14' : 'w-60'}`}>
                <div className="flex items-center gap-2 px-3 pb-2 pt-3">
                    <Link href="/" className="flex min-w-0 items-center gap-2" title="Home">
                        <Moon className="size-6 shrink-0" />
                        {!c && <span className="glow-text truncate text-[15px] font-semibold tracking-tight">Nightly</span>}
                    </Link>
                    <button aria-label={c ? 'Expand sidebar' : 'Collapse sidebar'} onClick={open ? () => setOpen(false) : toggle} className="icon-btn ml-auto hidden md:grid">{c ? '»' : '«'}</button>
                    <button aria-label="Close menu" onClick={() => setOpen(false)} className="icon-btn ml-auto md:hidden">✕</button>
                </div>
                <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                    {(allowed(p, 'transcripts.view') || allowed(p, 'agents.view')) && <>
                        {title('Transcripts', allowed(p, 'transcripts.view') ? '/transcripts' : undefined,
                            allowed(p, 'transcripts.run') ? <Link href="/transcripts/new" title="New transcript" aria-label="New transcript" className="icon-btn text-sm">+</Link> : null)}
                        {c && allowed(p, 'transcripts.run') && item({ href: '/transcripts/new', label: 'New transcript', icon: '+' })}
                        {allowed(p, ['transcripts.view', 'usage.view']) && <History collapsed={c} />}
                        {allowed(p, 'agents.view') && item({ href: '/transcripts/agents', label: 'Agents', icon: '◉' }, live.data)}
                    </>}
                    {nav.map((s) => (
                        <div key={s.key}>
                            {s.rule && !c && <hr className="mx-2 mt-4 border-line/70" />}
                            {s.title ? title(s.title, s.href) : c ? null : <div className="h-2" />}
                            {s.key === 'projects' && <>
                                {item({ href: '/projects', label: 'All projects', icon: '▤' })}
                                {!c && folders.data?.filter((f) => f.parentId == null).map((f) => (
                                    <Link key={f.id} href={`/projects?folder=${f.id}`} className="flex items-center gap-2.5 rounded-md px-2 py-1 pl-8 text-[12.5px] text-dim hover:bg-hover/70 hover:text-fg">
                                        <span className="truncate">{f.name}</span>
                                    </Link>
                                ))}
                            </>}
                            {s.links.map((l) => item(l, l.count ? (counts.data as Record<string, number> | undefined)?.[l.count] : null))}
                        </div>
                    ))}
                </nav>
                <div className="border-t border-line/70 px-3 py-2 text-[12px] text-dim">
                    {allowed(p, 'admin.schedules') && !c && (
                        <Link href="/admin/schedules" className="mb-1.5 flex items-center gap-1.5 text-[11px] hover:text-fg">
                            <span className={`size-1.5 rounded-full ${doRun ? 'bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400' : 'bg-zinc-600'}`} />
                            schedules {doRun ? 'live' : 'paused'}
                        </Link>
                    )}
                    <div className="flex items-center gap-2">
                        <Link href="/account/settings" className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/20 text-[11px] font-semibold uppercase text-fg" title={viewer.username}>{(viewer.name || viewer.username).slice(0, 1)}</Link>
                        {!c && <span className="min-w-0 flex-1 truncate">{viewer.name || viewer.username}</span>}
                        {!c && <form method="post" action="/api/logout"><button className="text-[11px] text-muted hover:text-fg">Sign out</button></form>}
                    </div>
                </div>
            </aside>
        </>
    )
}

/** Transcripts > History: recent sessions in a popover opened where the mouse clicked. */
function History({ collapsed }: { collapsed: boolean }) {
    const [at, setAt] = useState<{ x: number; y: number } | null>(null)
    const box = useRef<HTMLDivElement>(null)
    const [term, setTerm] = useState('')
    const q = api.transcripts.list.useQuery({ q: term, limit: 25 }, { enabled: !!at, staleTime: 10_000, placeholderData: (p) => p })
    useEffect(() => {
        if (!at) return
        const close = (e: MouseEvent | KeyboardEvent) => {
            if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setAt(null)
        }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', close)
        return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
    }, [at])
    const rows = q.data ?? []
    const W = 320, H = 380
    return (
        <>
            <button title="History" onClick={(e) => setAt({ x: Math.min(e.clientX, window.innerWidth - W - 8), y: Math.min(e.clientY, window.innerHeight - H - 8) })}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-dim transition hover:bg-hover/70 hover:text-fg">
                <span className="w-4 shrink-0 text-center opacity-80">↺</span>{!collapsed && 'History'}
            </button>
            {at && (
                <div ref={box} style={{ left: Math.max(8, at.x), top: Math.max(8, at.y), width: W, maxHeight: H }}
                    className="glow-card fixed z-[60] flex flex-col overflow-hidden p-0 text-[12.5px]">
                    <div className="flex items-center justify-between border-b border-line/70 px-3 py-2">
                        <input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search history" className="input mr-2 min-w-0 flex-1 text-[12px]" />
                        <Link href="/transcripts" onClick={() => setAt(null)} className="text-[11px] text-accent hover:underline">All transcripts</Link>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {q.isLoading && <div className="px-3 py-4 text-muted">Loading…</div>}
                        {q.error && <div className="px-3 py-4 text-red-400">{q.error.message}</div>}
                        {!q.isLoading && !q.error && !rows.length && <div className="px-3 py-6 text-center text-muted">No transcripts yet.</div>}
                        {rows.map((r) => (
                            <Link key={r.id} href={`/transcripts/${r.id}`} onClick={() => setAt(null)} className="block border-b border-line/40 px-3 py-1.5 hover:bg-hover/70">
                                <div className="truncate text-fg">{r.title || r.description || r.sessionId.slice(0, 8)}</div>
                                <div className="flex gap-2 text-[11px] text-muted">
                                    {r.gitBranch && <span className="truncate">{r.gitBranch}</span>}
                                    {r.lastAt ? <span>{new Date(r.lastAt).toLocaleString()}</span> : null}
                                    <span className="ml-auto tabular-nums">{r.messageCount} msgs</span>
                                </div>
                            </Link>
                        ))}
                    </div>
                </div>
            )}
        </>
    )
}
