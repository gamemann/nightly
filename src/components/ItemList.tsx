'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { KINDS, STATUSES, STATUS_LABEL, type Kind } from '~/lib/constants'
import type { View } from '~/server/api'
import { api } from '~/trpc/react'
import { KindTag, RepoChips, STATUS_DOT, StatusPill, ago } from './pills'

const TITLES: Record<View, string> = {
    queue: 'Queue', in_progress: 'In progress', review: 'Review', blocked: 'Blocked', issues: 'Issues', checks: 'Standing checks', done: 'Done', all: 'All items',
}
const HINT: Partial<Record<View, string>> = {
    queue: 'Worked top-down by the nightly run. Order is priority.',
    review: 'Done in a session; the nightly run reads it back with fresh eyes.',
    checks: 'Recurring checks, run when their cadence is due.',
    issues: 'Open items of kind issue, in any status.',
}

export function useDebounced<T>(v: T, ms: number) {
    const [d, setD] = useState(v)
    useEffect(() => {
        const t = setTimeout(() => setD(v), ms)
        return () => clearTimeout(t)
    }, [v, ms])
    return d
}

export function ItemList({ view }: { view: View }) {
    const [q, setQ] = useState('')
    const dq = useDebounced(q, 200)
    const utils = api.useUtils()
    const list = api.item.list.useQuery({ view, q: dq || undefined }, { placeholderData: (p) => p })
    const invalidate = () => Promise.all([utils.item.list.invalidate(), utils.item.counts.invalidate()])
    const move = api.item.move.useMutation({ onSuccess: invalidate })
    const update = api.item.update.useMutation({ onSuccess: invalidate })
    const searchRef = useRef<HTMLInputElement>(null)
    const orderable = !dq && ['queue', 'in_progress', 'review', 'blocked', 'checks'].includes(view)

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement
            if (t.closest('input,textarea,select')) return
            if (e.key === '/') { e.preventDefault(); searchRef.current?.focus() }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [])

    const items = list.data ?? []
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <QuickAdd view={view} onAdded={invalidate} />
            <div className="mt-5 mb-2 flex items-end justify-between gap-4">
                <div>
                    <h1 className="text-[15px] font-semibold tracking-tight">
                        {dq ? `Search “${dq}”` : TITLES[view]}
                        <span className="ml-2 text-[12px] font-normal text-muted tabular-nums">{items.length}</span>
                    </h1>
                    {!dq && HINT[view] && <p className="mt-0.5 text-[12px] text-muted">{HINT[view]}</p>}
                </div>
                <div className="relative">
                    <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all items…"
                        className="input w-64 pl-7 max-md:w-40" onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
                    <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted">⌕</span>
                    <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-line px-1 text-[10px] text-muted">/</kbd>
                </div>
            </div>
            <div className="overflow-hidden rounded-lg border border-line bg-panel/40">
                {list.isLoading && <div className="p-6 text-center text-muted">Loading…</div>}
                {!list.isLoading && !items.length && <div className="p-10 text-center text-muted">Nothing here.</div>}
                {items.map((it, i) => (
                    <div key={it.id} className="group flex items-center gap-3 border-b border-line/70 px-3 py-[7px] last:border-0 hover:bg-hover/50">
                        {orderable ? (
                            <span className="w-6 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-muted">{i + 1}</span>
                        ) : (
                            <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[it.status]}`} />
                        )}
                        <Link href={`/item/${encodeURIComponent(it.key)}`} className="w-40 shrink-0 truncate font-mono text-[11.5px] text-muted hover:text-accent max-lg:w-28">
                            {it.key}
                        </Link>
                        <KindTag kind={it.kind} />
                        <Link href={`/item/${encodeURIComponent(it.key)}`} className="min-w-0 flex-1 truncate text-fg/95 hover:text-white">
                            {it.title}
                        </Link>
                        {it.kind === 'check' && (
                            <span className={`shrink-0 text-[11px] ${it.due ? 'text-teal-300' : 'text-muted'}`}>
                                {it.cadence}{it.due ? ' · due' : ` · ${ago(it.lastRunAt)}`}
                            </span>
                        )}
                        <span className="max-w-[30%] max-lg:hidden"><RepoChips repos={it.repos} /></span>
                        {it._count.notes > 0 && <span className="shrink-0 text-[11px] text-muted" title="notes">✉ {it._count.notes}</span>}
                        {view === 'done' ? (
                            <span className="w-20 shrink-0 text-right text-[11px] text-muted">{ago(it.completedAt)}</span>
                        ) : (
                            <select value={it.status} aria-label="status"
                                onChange={(e) => update.mutate({ key: it.key, patch: { status: e.target.value as (typeof STATUSES)[number] } })}
                                className="w-24 shrink-0 cursor-pointer appearance-none bg-transparent text-right text-[11.5px] text-dim outline-none hover:text-fg">
                                {STATUSES.map((s) => <option key={s} value={s} className="bg-panel">{STATUS_LABEL[s]}</option>)}
                            </select>
                        )}
                        {view === 'done' && <StatusPill status={it.status} />}
                        {orderable && (
                            <span className="flex shrink-0 gap-0.5 opacity-0 transition group-hover:opacity-100 max-md:opacity-100">
                                <button className="icon-btn" title="Move to top" disabled={i === 0} onClick={() => move.mutate({ key: it.key, to: 'top' })}>⤒</button>
                                <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => move.mutate({ key: it.key, to: 'up' })}>↑</button>
                                <button className="icon-btn" title="Move down" disabled={i === items.length - 1} onClick={() => move.mutate({ key: it.key, to: 'down' })}>↓</button>
                            </span>
                        )}
                    </div>
                ))}
            </div>
        </div>
    )
}

function QuickAdd({ view, onAdded }: { view: View; onAdded: () => unknown }) {
    const router = useRouter()
    const defaultKind: Kind = view === 'issues' ? 'issue' : view === 'checks' ? 'check' : 'task'
    const [title, setTitle] = useState('')
    const [kind, setKind] = useState<Kind>(defaultKind)
    const [repos, setRepos] = useState('')
    const [position, setPosition] = useState<'top' | 'bottom'>('bottom')
    const [open, setOpen] = useState(false)
    const [flash, setFlash] = useState<string | null>(null)
    const ref = useRef<HTMLInputElement>(null)
    useEffect(() => setKind(defaultKind), [defaultKind])
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.target as HTMLElement).closest('input,textarea,select')) return
            if (e.key === 'c' || e.key === 'n') { e.preventDefault(); ref.current?.focus() }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [])
    const status = view === 'in_progress' || view === 'review' || view === 'blocked' ? view : 'queue'
    const create = api.item.create.useMutation({
        onSuccess: async (it) => {
            setTitle('')
            setFlash(it.key)
            setTimeout(() => setFlash(null), 3000)
            await onAdded()
        },
    })
    const submit = (go: boolean) => {
        if (!title.trim()) return
        create.mutate({ title, kind, repos, position, status }, { onSuccess: (it) => go && router.push(`/item/${it.key}`) })
    }
    return (
        <div className={`rounded-lg border bg-panel transition ${open ? 'border-line-strong shadow-lg shadow-black/30' : 'border-line'}`}>
            <div className="flex items-center gap-2 px-3">
                <span className="text-lg leading-none text-accent">+</span>
                <input ref={ref} value={title} onChange={(e) => setTitle(e.target.value)} onFocus={() => setOpen(true)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); submit(e.metaKey || e.ctrlKey) }
                        if (e.key === 'Escape') { setTitle(''); ref.current?.blur(); setOpen(false) }
                    }}
                    placeholder={`Add ${kind === 'issue' ? 'an issue' : `a ${kind}`} to ${STATUS_LABEL[status].toLowerCase()} — type a title, press Enter   (c)`}
                    className="h-10 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-muted" />
                {flash && <Link href={`/item/${flash}`} className="text-[11px] text-emerald-300">added {flash} →</Link>}
                {create.error && <span className="text-[11px] text-red-400">{create.error.message}</span>}
            </div>
            {open && (
                <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2 text-[12px]">
                    <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className="select">
                        {KINDS.map((k) => <option key={k}>{k}</option>)}
                    </select>
                    <input value={repos} onChange={(e) => setRepos(e.target.value)} placeholder="repos (comma list)" className="input w-56 py-1" />
                    <div className="flex overflow-hidden rounded-md border border-line">
                        {(['top', 'bottom'] as const).map((p) => (
                            <button key={p} onClick={() => setPosition(p)}
                                className={`px-2.5 py-1 ${position === p ? 'bg-hover text-fg' : 'text-muted hover:text-dim'}`}>
                                {p === 'top' ? '⤒ top' : '⤓ bottom'}
                            </button>
                        ))}
                    </div>
                    <span className="ml-auto text-[11px] text-muted">Enter adds · Ctrl+Enter adds and opens · Esc closes</span>
                    <button className="btn-primary" disabled={!title.trim() || create.isPending} onClick={() => submit(false)}>Add</button>
                </div>
            )}
        </div>
    )
}
