'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { gameLabel } from '~/lib/games'
import { api } from '~/trpc/react'
import { PictureViewer, type Shot } from './PictureViewer'
import { StatusPill, ago, fmt } from './pills'
import { DataTable, type Column } from './DataTable'
import { Pagination, useUrlParams } from './Pagination'
import { parsePage } from '~/lib/paging'

const TABS = ['items', 'runs', 'media', 'reviews', 'qa'] as const
type Tab = (typeof TABS)[number]

export function GameIndex() {
    const list = api.game.list.useQuery(undefined, { refetchInterval: 30_000 })
    return (
        <div className="mx-auto max-w-4xl px-6 py-5 max-md:px-3">
            <h1 className="text-[15px] font-semibold tracking-tight">Games</h1>
            <p className="mt-0.5 mb-4 text-[12px] text-muted">Derived from each item&apos;s repos and each QA run&apos;s game.</p>
            <div className="grid gap-3 sm:grid-cols-2">
                {list.data?.map((g) => (
                    <Link key={g.slug} href={`/projects/${g.slug}/tasks`} className="rounded-lg border border-line bg-panel/40 px-4 py-3 hover:bg-hover/50">
                        <div className="font-medium">{gameLabel(g.slug)} <span className="font-mono text-[11px] text-muted">{g.slug}</span></div>
                        <div className="mt-1 text-[12px] text-muted">{g.open} open · {g.total} items · {g.qa} QA runs{g.qaFailing ? ' · latest failing' : ''}</div>
                    </Link>
                ))}
            </div>
        </div>
    )
}

const ITEM_SPEC = { sorts: ['updatedAt', 'title', 'status', 'key'], sort: 'updatedAt', dir: 'desc', filters: ['status'] } as const
const RUN_SPEC = { sorts: ['startedAt', 'id', 'status'], sort: 'startedAt', dir: 'desc', filters: ['status'] } as const
const MEDIA_SPEC = { sorts: ['at'], sort: 'at', dir: 'desc', filters: ['kind'] } as const
const QA_SPEC = { sorts: ['ranAt'], sort: 'ranAt', dir: 'desc', filters: ['state'] } as const

export function GamePage({ slug }: { slug: string }) {
    const [tab, setTab] = useState<Tab>('items')
    const q = api.game.get.useQuery({ slug }, { refetchInterval: 30_000 })
    const d = q.data
    const count: Record<Tab, number | undefined> = { items: d?.items, runs: d?.runs, media: d?.media, reviews: d?.reviews, qa: d?.qa }
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <h1 className="text-[15px] font-semibold tracking-tight">{gameLabel(slug)} <span className="font-mono text-[11px] font-normal text-muted">{slug}</span></h1>
            <div className="mt-3 mb-4 flex flex-wrap gap-1 border-b border-line text-[13px]">
                {TABS.map((t) => (
                    <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-1.5 capitalize ${tab === t ? 'border-accent text-fg' : 'border-transparent text-dim hover:text-fg'}`}>
                        {t === 'qa' ? 'QA' : t}<span className="ml-1.5 text-[11px] tabular-nums text-muted">{count[t] ?? ''}</span>
                    </button>
                ))}
            </div>
            {tab === 'items' && <Items slug={slug} ns="i" />}
            {tab === 'reviews' && <Items slug={slug} ns="v" reviews />}
            {tab === 'runs' && <GameRuns slug={slug} />}
            {tab === 'media' && <Media slug={slug} />}
            {tab === 'qa' && <QaList slug={slug} />}
        </div>
    )
}

const opts = (xs?: string[]) => (xs ?? []).map((value) => ({ value }))
const Loading = () => <div className="p-6 text-center text-muted">Loading…</div>

function Items({ slug, ns, reviews }: { slug: string; ns: string; reviews?: boolean }) {
    const { sp } = useUrlParams(ns)
    const pq = parsePage(sp, ITEM_SPEC, ns)
    const res = api.game.items.useQuery({ slug, reviews: !!reviews, page: pq.page, size: pq.size, sort: pq.sort, dir: pq.dir, q: pq.q || undefined, f: pq.f }, { placeholderData: (p) => p })
    const data = res.data?.page
    if (!data) return <Loading />
    const cols: Column<(typeof data.rows)[number]>[] = [
        { key: 'status', label: 'Status', sortable: true, render: (i) => <StatusPill status={i.status} /> },
        { key: 'title', label: 'Title', sortable: true, className: 'max-w-[32rem] truncate', render: (i) => <Link href={`/item/${encodeURIComponent(i.key)}`} className="hover:text-accent">{i.title}</Link> },
        { key: 'key', label: 'Key', sortable: true, className: 'font-mono text-[11px] text-muted max-md:hidden', render: (i) => i.key },
        { key: 'updatedAt', label: 'Updated', sortable: true, className: 'whitespace-nowrap text-right text-[11px] text-muted', render: (i) => ago(i.updatedAt) },
    ]
    return <DataTable cols={cols} data={data} rowKey={(i) => i.key} sort={pq.sort} dir={pq.dir} q={pq.q} active={pq.f} ns={ns} searchHint="Search title or key" empty="Nothing here."
        filters={[{ key: 'status', label: 'Status', options: opts(res.data?.statuses) }]} />
}

function GameRuns({ slug }: { slug: string }) {
    const { sp } = useUrlParams('r')
    const pq = parsePage(sp, RUN_SPEC, 'r')
    const res = api.game.runs.useQuery({ slug, page: pq.page, size: pq.size, sort: pq.sort, dir: pq.dir, q: pq.q || undefined, f: pq.f }, { placeholderData: (p) => p })
    const data = res.data?.page
    if (!data) return <Loading />
    const cols: Column<(typeof data.rows)[number]>[] = [
        { key: 'id', label: '#', sortable: true, className: 'font-mono text-[11px] text-muted', render: (r) => <Link href={`/admin/runs/${r.id}`}>#{r.id}</Link> },
        { key: 'startedAt', label: 'Started', sortable: true, className: 'whitespace-nowrap text-dim', render: (r) => fmt(r.startedAt) },
        { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusPill status={r.status} /> },
        { key: 'summary', label: 'Summary', className: 'max-w-[32rem] truncate text-dim', render: (r) => <Link href={`/admin/runs/${r.id}`}>{r.summary}</Link> },
    ]
    return <DataTable cols={cols} data={data} rowKey={(r) => r.id} sort={pq.sort} dir={pq.dir} q={pq.q} active={pq.f} ns="r" searchHint="Search summaries"
        empty="No run has written a note on this game's items." filters={[{ key: 'status', label: 'Status', options: opts(res.data?.statuses) }]} />
}

function Media({ slug }: { slug: string }) {
    const [open, setOpen] = useState<Shot | null>(null)
    const { sp, set } = useUrlParams('p')
    const pq = parsePage(sp, MEDIA_SPEC, 'p')
    const [text, setText] = useState(pq.q)
    useEffect(() => { if (text === pq.q) return; const t = setTimeout(() => set({ q: text }), 300); return () => clearTimeout(t) }, [text]) // eslint-disable-line react-hooks/exhaustive-deps
    const res = api.game.media.useQuery({ slug, page: pq.page, size: pq.size, sort: pq.sort, dir: pq.dir, q: pq.q || undefined, f: pq.f }, { placeholderData: (p) => p })
    const data = res.data?.page
    const sel = 'rounded-md border border-line bg-panel px-2 py-1 text-[12px]'
    return (
        <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
                <input className={`${sel} w-56`} placeholder="Search item, note or file" aria-label="search" value={text} onChange={(e) => setText(e.target.value)} />
                <select className={sel} aria-label="kind" value={pq.f.kind ?? ''} onChange={(e) => set({ kind: e.target.value })}>
                    <option value="">all shots</option><option value="3d">with 3D model</option>
                </select>
                <select className={sel} aria-label="order" value={pq.dir} onChange={(e) => set({ dir: e.target.value })}>
                    <option value="desc">newest first</option><option value="asc">oldest first</option>
                </select>
            </div>
            {!data ? <Loading /> : !data.rows.length ? <div className="p-6 text-center text-muted">No screenshots on this game&apos;s items.</div> : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                    {data.rows.map((a) => (
                        <figure key={a.item + a.file} className="space-y-1">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={`/attachments/${encodeURIComponent(a.item)}/${encodeURIComponent(a.file)}`} alt={a.note || a.file} loading="lazy" onClick={() => setOpen(a)} className="h-36 w-full cursor-zoom-in rounded-md border border-line object-cover" />
                            <figcaption className="text-xs text-muted">
                                {a.model && <span className="mr-1 rounded bg-accent/15 px-1 text-accent">3D</span>}
                                <Link href={`/item/${encodeURIComponent(a.item)}`} className="font-mono text-dim hover:text-fg">{a.item}</Link>
                                <div className="line-clamp-2 text-dim">{a.note || a.file}</div>
                            </figcaption>
                        </figure>
                    ))}
                </div>
            )}
            {data && <Pagination p={data} ns="p" />}
            {open && <PictureViewer shot={open} onClose={() => setOpen(null)} />}
        </>
    )
}

function QaList({ slug }: { slug: string }) {
    const { sp, set } = useUrlParams('q')
    const pq = parsePage(sp, QA_SPEC, 'q')
    const [text, setText] = useState(pq.q)
    useEffect(() => { if (text === pq.q) return; const t = setTimeout(() => set({ q: text }), 300); return () => clearTimeout(t) }, [text]) // eslint-disable-line react-hooks/exhaustive-deps
    const res = api.game.qa.useQuery({ slug, page: pq.page, size: pq.size, sort: pq.sort, dir: pq.dir, q: pq.q || undefined, f: pq.f }, { placeholderData: (p) => p })
    const data = res.data?.page
    const sel = 'rounded-md border border-line bg-panel px-2 py-1 text-[12px]'
    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <input className={`${sel} w-56`} placeholder="Search kind or commit" aria-label="search" value={text} onChange={(e) => setText(e.target.value)} />
                <select className={sel} aria-label="state" value={pq.f.state ?? ''} onChange={(e) => set({ state: e.target.value })}>
                    <option value="">all runs</option><option value="ok">ok</option><option value="failing">failing</option>
                </select>
                <select className={sel} aria-label="order" value={pq.dir} onChange={(e) => set({ dir: e.target.value })}>
                    <option value="desc">newest first</option><option value="asc">oldest first</option>
                </select>
                <Link href="/tools/reviews?tab=qa" className="ml-auto text-[12px] text-accent">All games on the QA page</Link>
            </div>
            {!data ? <Loading /> : !data.rows.length && <div className="p-6 text-center text-muted">No QA runs match.</div>}
            {data?.rows.map((r) => (
                <div key={r.id} className="rounded-lg border border-line bg-panel/40 px-4 py-3">
                    <div className="flex items-center gap-3 text-[13px]">
                        <span className={`rounded px-1.5 text-[11px] ${r.ok ? 'bg-emerald-400/15 text-emerald-300' : 'bg-red-400/15 text-red-300'}`}>{r.ok ? 'ok' : 'failing'}</span>
                        <span className="font-medium">{r.kind}</span>
                        <span className="text-muted">{r.failedCount} / {r.total} failed</span>
                        <span className="ml-auto text-[11px] text-muted">{r.commit.slice(0, 8)} · {fmt(r.ranAt)}</span>
                    </div>
                    {r.failures.slice(0, 5).map((f) => <div key={f.name} className="mt-1 truncate font-mono text-[11.5px] text-red-300/90" title={f.reasons.join('; ')}>{f.name}{f.reasons[0] ? ` · ${f.reasons[0]}` : ''}</div>)}
                    {r.images.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                            {r.images.filter((i) => /\.(png|jpe?g)$/i.test(i.file)).slice(0, 6).map((i) => (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img key={i.file} src={`/attachments/qa-${r.id}/${encodeURIComponent(i.file)}`} alt={i.note || i.file} loading="lazy" className="h-20 rounded border border-line" />
                            ))}
                        </div>
                    )}
                </div>
            ))}
            {data && <Pagination p={data} ns="q" />}
        </div>
    )
}
