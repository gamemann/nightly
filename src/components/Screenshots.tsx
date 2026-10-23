'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { api } from '~/trpc/react'
import { ago } from './pills'

const PAGE = 48

type Shot = { item: string; file: string; note: string; by: string; at: string }
const url = (a: Shot) => `/attachments/${encodeURIComponent(a.item)}/${encodeURIComponent(a.file)}`

export function Screenshots() {
    const [item, setItem] = useState('')
    const [text, setText] = useState('')
    const [q, setQ] = useState('')
    const [page, setPage] = useState(0)
    const [open, setOpen] = useState<Shot | null>(null)
    useEffect(() => {
        const t = setTimeout(() => { setQ(text); setPage(0) }, 250)
        return () => clearTimeout(t)
    }, [text])
    const list = api.attachment.list.useQuery({ item: item || undefined, q: q || undefined, limit: PAGE, offset: page * PAGE }, { refetchInterval: 30_000 })
    const d = list.data
    const pages = d ? Math.max(1, Math.ceil(d.total / PAGE)) : 1
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <h1 className="text-[15px] font-semibold tracking-tight">
                Screenshots<span className="ml-2 text-[12px] font-normal tabular-nums text-muted">{d ? d.total : ''}</span>
            </h1>
            <p className="mt-0.5 mb-4 text-[12px] text-muted">Every screenshot attached to an item (<code className="font-mono">nightly attach</code>), newest first.</p>
            <div className="mb-4 flex flex-wrap gap-2">
                <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter by item or note…" className="min-w-64 flex-1 rounded-md border border-line bg-transparent px-2.5 py-1.5 text-[13px]" />
                <select value={item} onChange={(e) => { setItem(e.target.value); setPage(0) }} className="rounded-md border border-line bg-panel px-2 py-1.5 text-[13px]">
                    <option value="">All items</option>
                    {d?.items.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
            </div>
            {list.isLoading && <div className="p-6 text-center text-muted">Loading…</div>}
            {d && d.rows.length === 0 && <div className="p-6 text-center text-muted">No screenshots.</div>}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                {d?.rows.map((a) => (
                    <figure key={a.item + a.file} className="space-y-1">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url(a)} alt={a.note || a.file} loading="lazy" onClick={() => setOpen(a)} className="h-36 w-full cursor-zoom-in rounded-md border border-line object-cover" />
                        <figcaption className="text-xs text-muted">
                            <Link href={`/item/${encodeURIComponent(a.item)}`} className="font-mono text-dim hover:text-fg">{a.item}</Link>
                            <div className="line-clamp-2 text-dim" title={a.note}>{a.note || a.file}</div>
                            <div>{ago(new Date(a.at))} · {a.by} · {new Date(a.at).toLocaleString('en-GB')}</div>
                        </figcaption>
                    </figure>
                ))}
            </div>
            {pages > 1 && (
                <div className="mt-5 flex items-center justify-center gap-3 text-[13px]">
                    <button disabled={page === 0} onClick={() => setPage(page - 1)} className="rounded-md border border-line px-3 py-1 disabled:opacity-40">Prev</button>
                    <span className="tabular-nums text-muted">{page + 1} / {pages}</span>
                    <button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} className="rounded-md border border-line px-3 py-1 disabled:opacity-40">Next</button>
                </div>
            )}
            {open && (
                <div onClick={() => setOpen(null)} className="fixed inset-0 z-50 flex cursor-zoom-out flex-col items-center justify-center gap-2 bg-black/80 p-6">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url(open)} alt={open.note || open.file} className="max-h-[85vh] max-w-full rounded-md" />
                    <p className="text-sm text-white">{open.item}{open.note ? ` · ${open.note}` : ''}</p>
                </div>
            )}
        </div>
    )
}
