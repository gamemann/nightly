'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { KINDS, STATUSES, STATUS_LABEL, type Kind } from '~/lib/constants'
import type { View } from '~/server/api'
import { api, type RouterOutputs } from '~/trpc/react'
import { parsePage } from '~/lib/paging'
import { DataTable, type Column } from './DataTable'
import { useUrlParams } from './Pagination'
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

const ITEM_SORT = ['key', 'title', 'kind', 'status', 'priority', 'updated', 'done']
type Row = RouterOutputs['item']['list']['rows'][number]

export function ItemList({ view }: { view: View }) {
    const { sp } = useUrlParams()
    const q = parsePage(sp, { sorts: ITEM_SORT, sort: view === 'done' ? 'done' : 'priority', dir: view === 'done' ? 'desc' : 'asc', filters: ['kind', 'status'] })
    const utils = api.useUtils()
    const list = api.item.list.useQuery(
        { view, q: q.q || undefined, page: q.page, size: q.size, sort: q.sort as 'key', dir: q.dir, kind: q.f.kind, status: q.f.status },
        { placeholderData: (p) => p })
    const invalidate = () => Promise.all([utils.item.list.invalidate(), utils.item.counts.invalidate()])
    const move = api.item.move.useMutation({ onSuccess: invalidate })
    const update = api.item.update.useMutation({ onSuccess: invalidate })

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.target as HTMLElement).closest('input,textarea,select')) return
            if (e.key === '/') { e.preventDefault(); document.querySelector<HTMLInputElement>('input[aria-label="search"]')?.focus() }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [])

    const data = list.data
    const orderable = !!data?.orderable
    const base = data ? data.from - 1 : 0
    const cols: Column<Row>[] = [
        { key: 'priority', label: '#', sortable: true, className: 'w-10 text-right font-mono text-[11px] text-muted', render: (it) => (orderable && data ? base + data.rows.indexOf(it) + 1 : <span className={`inline-block size-2 rounded-full ${STATUS_DOT[it.status]}`} />) },
        { key: 'key', label: 'Key', sortable: true, render: (it) => <Link href={`/item/${encodeURIComponent(it.key)}`} className="font-mono text-[11.5px] text-muted hover:text-accent">{it.key}</Link> },
        { key: 'kind', label: 'Kind', sortable: true, render: (it) => <KindTag kind={it.kind} /> },
        { key: 'title', label: 'Title', sortable: true, className: 'max-w-[32rem] truncate', render: (it) => <Link href={`/item/${encodeURIComponent(it.key)}`} className="hover:text-white">{it.title}</Link> },
        { key: 'cadence', label: 'Check', render: (it) => (it.kind === 'check' ? <span className={`text-[11px] ${it.due ? 'text-teal-300' : 'text-muted'}`}>{it.cadence}{it.due ? ' · due' : ` · ${ago(it.lastRunAt)}`}</span> : null) },
        { key: 'repos', label: 'Repos', className: 'max-lg:hidden', render: (it) => <RepoChips repos={it.repos} /> },
        { key: 'notes', label: '', className: 'text-[11px] text-muted', render: (it) => (it._count.notes > 0 ? `✉ ${it._count.notes}` : '') },
        { key: view === 'done' ? 'done' : 'updated', label: view === 'done' ? 'Done' : 'Updated', sortable: true, className: 'whitespace-nowrap text-[11px] text-muted', render: (it) => ago(view === 'done' ? it.completedAt : it.updatedAt) },
        { key: 'status', label: 'Status', sortable: true, render: (it) => (view === 'done' ? <StatusPill status={it.status} /> : (
            <select value={it.status} aria-label="status" onChange={(e) => update.mutate({ key: it.key, patch: { status: e.target.value as (typeof STATUSES)[number] } })}
                className="cursor-pointer appearance-none bg-transparent text-[11.5px] text-dim outline-none hover:text-fg">
                {STATUSES.map((s) => <option key={s} value={s} className="bg-panel">{STATUS_LABEL[s]}</option>)}
            </select>)) },
        ...(orderable ? [{ key: 'move', label: '', render: (it: Row) => {
            const i = data!.rows.indexOf(it)
            const first = base + i === 0
            const last = base + i === data!.total - 1
            return (
                <span className="flex gap-0.5">
                    <button className="icon-btn" title="Move to top" disabled={first} onClick={() => move.mutate({ key: it.key, to: 'top' })}>⤒</button>
                    <button className="icon-btn" title="Move up" disabled={first} onClick={() => move.mutate({ key: it.key, to: 'up' })}>↑</button>
                    <button className="icon-btn" title="Move down" disabled={last} onClick={() => move.mutate({ key: it.key, to: 'down' })}>↓</button>
                </span>
            )
        } }] : []),
    ]
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <QuickAdd view={view} onAdded={invalidate} />
            <div className="mt-5 mb-2">
                <h1 className="text-[15px] font-semibold tracking-tight">
                    {q.q ? `Search “${q.q}”` : TITLES[view]}
                    <span className="ml-2 text-[12px] font-normal text-muted tabular-nums">{data?.total ?? ''}</span>
                </h1>
                {!q.q && HINT[view] && <p className="mt-0.5 text-[12px] text-muted">{HINT[view]}</p>}
            </div>
            {!data ? <div className="p-6 text-center text-muted">Loading…</div> : (
                <DataTable cols={cols} data={data} rowKey={(it) => it.id} sort={q.sort} dir={q.dir} q={q.q} active={q.f} searchHint="Search all items (/)"
                    filters={[{ key: 'kind', label: 'Kind', options: KINDS.map((value) => ({ value })) }, { key: 'status', label: 'Status', options: STATUSES.map((value) => ({ value, label: STATUS_LABEL[value] })) }]} />
            )}
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
