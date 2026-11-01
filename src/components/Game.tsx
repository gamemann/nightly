'use client'
import Link from 'next/link'
import { useState } from 'react'
import { gameLabel } from '~/lib/games'
import { api } from '~/trpc/react'
import { PictureViewer, type Shot } from './PictureViewer'
import { StatusPill, ago, fmt } from './pills'

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
                    <Link key={g.slug} href={`/game/${g.slug}`} className="rounded-lg border border-line bg-panel/40 px-4 py-3 hover:bg-hover/50">
                        <div className="font-medium">{gameLabel(g.slug)} <span className="font-mono text-[11px] text-muted">{g.slug}</span></div>
                        <div className="mt-1 text-[12px] text-muted">{g.open} open · {g.total} items · {g.qa} QA runs{g.qaFailing ? ' · latest failing' : ''}</div>
                    </Link>
                ))}
            </div>
        </div>
    )
}

export function GamePage({ slug }: { slug: string }) {
    const [tab, setTab] = useState<Tab>('items')
    const q = api.game.get.useQuery({ slug }, { refetchInterval: 30_000 })
    const d = q.data
    const count: Record<Tab, number | undefined> = { items: d?.items.length, runs: d?.runs.length, media: d?.shots.length, reviews: d?.reviews.length, qa: d?.qa.length }
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
            {q.isLoading && <div className="p-6 text-center text-muted">Loading…</div>}
            {d && tab === 'items' && <Items rows={d.items} />}
            {d && tab === 'reviews' && <Items rows={d.reviews} />}
            {d && tab === 'runs' && (
                <div className="overflow-hidden rounded-lg border border-line bg-panel/40">
                    {d.runs.length === 0 && <div className="p-6 text-center text-muted">No run has written a note on this game&apos;s items.</div>}
                    {d.runs.map((r) => (
                        <Link key={r.id} href={`/runs/${r.id}`} className="flex items-center gap-3 border-b border-line/70 px-4 py-2.5 last:border-0 hover:bg-hover/50">
                            <span className="w-10 font-mono text-[11px] text-muted">#{r.id}</span>
                            <span className="w-36 shrink-0 text-dim">{fmt(r.startedAt)}</span>
                            <StatusPill status={r.status} />
                            <span className="min-w-0 flex-1 truncate text-dim">{r.summary}</span>
                        </Link>
                    ))}
                </div>
            )}
            {d && tab === 'media' && <Media shots={d.shots} />}
            {d && tab === 'qa' && <QaList rows={d.qa} />}
        </div>
    )
}

function Items({ rows }: { rows: { key: string; title: string; status: string; kind: string; updatedAt: Date }[] }) {
    if (!rows.length) return <div className="p-6 text-center text-muted">Nothing here.</div>
    return (
        <div className="overflow-hidden rounded-lg border border-line bg-panel/40">
            {rows.map((i) => (
                <Link key={i.key} href={`/item/${encodeURIComponent(i.key)}`} className="flex items-center gap-3 border-b border-line/70 px-4 py-2 last:border-0 hover:bg-hover/50">
                    <StatusPill status={i.status} />
                    <span className="min-w-0 flex-1 truncate">{i.title}</span>
                    <span className="font-mono text-[11px] text-muted max-md:hidden">{i.key}</span>
                    <span className="w-16 text-right text-[11px] text-muted">{ago(i.updatedAt)}</span>
                </Link>
            ))}
        </div>
    )
}

function Media({ shots }: { shots: Shot[] }) {
    const [open, setOpen] = useState<Shot | null>(null)
    if (!shots.length) return <div className="p-6 text-center text-muted">No screenshots on this game&apos;s items.</div>
    return (
        <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                {shots.map((a) => (
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
            {open && <PictureViewer shot={open} onClose={() => setOpen(null)} />}
        </>
    )
}

function QaList({ rows }: { rows: { id: number; kind: string; ranAt: Date; ok: boolean; total: number; failedCount: number; commit: string; failures: { name: string; reasons: string[] }[]; images: { file: string; note: string }[] }[] }) {
    if (!rows.length) return <div className="p-6 text-center text-muted">No QA runs for this game. <Link href="/qa" className="text-accent">All QA</Link></div>
    return (
        <div className="space-y-3">
            <p className="text-[12px] text-muted">Newest first. <Link href="/qa" className="text-accent">All games on the QA page</Link>.</p>
            {rows.map((r) => (
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
        </div>
    )
}
