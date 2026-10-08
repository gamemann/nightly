'use client'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { api } from '~/trpc/react'
import { useDebounced } from './ItemList'
import { Markdown } from './Markdown'
import { StatusPill, ago, fmt } from './pills'

export const dur = (m: number | null) => (m == null ? '' : m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`)
const usd = (c: number | null) => (c == null ? '' : `$${c.toFixed(2)}`)
/** Local calendar day of a run, which is how screenshots are filed. */
const day = (d: Date | string) => {
    const x = new Date(d)
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

export function RunList() {
    const [q, setQ] = useState('')
    const dq = useDebounced(q, 250)
    const runs = api.run.list.useQuery({ q: dq || undefined }, { placeholderData: (p) => p, refetchInterval: 30_000 })
    const rows = runs.data ?? []
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <div className="mb-3 flex items-end justify-between gap-4">
                <div>
                    <h1 className="text-[15px] font-semibold tracking-tight">
                        Runs &amp; reports<span className="ml-2 text-[12px] font-normal tabular-nums text-muted">{rows.length}</span>
                    </h1>
                    <p className="mt-0.5 text-[12px] text-muted">
                        Every run since the first, with its report, log and frames. When they start is set in <Link href="/schedules" className="text-dim hover:text-accent">Schedules</Link>.
                    </p>
                </div>
                <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')}
                    placeholder="Search reports and logs…" className="input w-64 max-md:w-40" />
            </div>
            <div className="overflow-hidden rounded-lg border border-line bg-panel/40">
                {runs.isLoading && <div className="p-6 text-center text-muted">Loading…</div>}
                {!runs.isLoading && rows.length === 0 && <div className="p-10 text-center text-muted">{dq ? 'No run mentions that.' : 'No runs yet.'}</div>}
                {rows.map((r) => (
                    <Link key={r.id} href={`/runs/${r.id}`} className="flex items-center gap-4 border-b border-line/70 px-4 py-2.5 last:border-0 hover:bg-hover/50 max-md:gap-2">
                        <span className="w-8 shrink-0 font-mono text-[11px] text-muted">#{r.id}</span>
                        <span className="w-40 shrink-0 text-dim max-md:w-28">{fmt(r.startedAt)}</span>
                        <StatusPill status={r.status} />
                        <span className="w-20 shrink-0 truncate text-[11px] text-muted max-lg:hidden" title={r.trigger}>
                            {r.schedule?.name ?? (r.trigger === 'import' ? 'imported' : r.trigger)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-fg/90">{r.summary || <span className="text-muted">no summary</span>}</span>
                        {r._count.notes > 0 && <span className="text-[11px] text-muted max-md:hidden">✉ {r._count.notes}</span>}
                        <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-muted max-md:hidden">{usd(r.costUsd)}</span>
                        <span className="w-14 shrink-0 text-right text-[11px] text-muted">{r.status === 'running' ? ago(r.startedAt).replace(' ago', '') : dur(r.minutes)}</span>
                    </Link>
                ))}
            </div>
        </div>
    )
}

export function RunDetail({ id }: { id: number }) {
    const utils = api.useUtils()
    const q = api.run.get.useQuery({ id }, { refetchInterval: (query) => (query.state.data?.status === 'running' ? 4000 : false) })
    const r = q.data
    const media = api.run.media.useQuery({ date: r ? day(r.startedAt) : '' }, { enabled: !!r })
    const stop = api.run.stop.useMutation({ onSuccess: () => Promise.all([utils.run.get.invalidate({ id }), utils.run.list.invalidate()]) })
    if (q.isLoading) return <div className="p-10 text-muted">Loading…</div>
    if (!r) return <div className="p-10 text-muted">No run #{id}.</div>
    const running = r.status === 'running'
    const showLog = r.log.trim() && r.log.trim() !== r.report.trim()
    return (
        <div className="mx-auto max-w-5xl px-6 py-5 max-md:px-3">
            <div className="mb-2 flex items-center gap-2 text-[12px] text-muted">
                <Link href="/runs" className="hover:text-fg">← Runs</Link>
                <span className="font-mono">#{r.id}</span>
                <StatusPill status={r.status} />
                {running && (
                    <button className="btn ml-auto" disabled={stop.isPending}
                        onClick={() => confirm(`Stop run #${r.id}? Claude and everything it started get SIGTERM.`) && stop.mutate({ id: r.id })}>
                        ■ Stop
                    </button>
                )}
            </div>
            <h1 className="text-[20px] font-semibold tracking-tight">Run of {fmt(r.startedAt)}</h1>
            <p className="mt-1 text-[12px] text-muted">
                {r.schedule ? <>schedule <Link href="/schedules" className="text-dim hover:text-accent">{r.schedule.name}</Link> · </> : null}
                {r.trigger === 'manual' ? 'started by hand · ' : r.trigger === 'import' ? 'imported from files · ' : ''}
                {r.finishedAt ? `finished ${ago(r.finishedAt)}` : running ? `running for ${ago(r.startedAt).replace(' ago', '')}` : 'never finished'}
                {r.minutes != null && ` · ${dur(r.minutes)}`}{r.turns != null && ` · ${r.turns} turns`}{r.costUsd != null && ` · ${usd(r.costUsd)}`}
            </p>
            {stop.error && <p className="mt-2 text-[12px] text-red-300">{stop.error.message}</p>}
            {r.summary && <p className="mt-4 rounded-md border border-line bg-panel/60 px-3.5 py-2.5 text-dim">{r.summary}</p>}
            {running && <LiveLog log={r.log} />}
            {r.notes.length > 0 && (
                <section className="mt-6">
                    <span className="label">Items touched · {r.notes.length}</span>
                    <ul className="mt-2 space-y-2">
                        {r.notes.map((n) => (
                            <li key={n.id} className="rounded-lg border border-line bg-panel/40 px-3.5 py-2.5">
                                <Link href={`/item/${n.item.key}`} className="mb-1 flex items-center gap-2 text-[12px]">
                                    <span className="font-mono text-muted">{n.item.key}</span>
                                    <span className="truncate text-fg hover:text-accent">{n.item.title}</span>
                                    <StatusPill status={n.item.status} />
                                </Link>
                                <Markdown>{n.body}</Markdown>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            <section className="mt-6">
                <span className="label">Report</span>
                <div className="mt-2 rounded-lg border border-line bg-panel/30 px-5 py-4">
                    {r.report.trim() ? <Markdown>{r.report}</Markdown> : <span className="text-muted">{running ? 'Written when the run finishes.' : 'No report.'}</span>}
                </div>
            </section>
            {!!media.data?.length && <Gallery files={media.data} />}
            {showLog && !running && (
                <details className="mt-6 rounded-lg border border-line bg-panel/30">
                    <summary className="cursor-pointer px-4 py-2.5 text-[12px] text-dim select-none hover:text-fg">Runner log · {Math.round(r.log.length / 1024)} KB</summary>
                    <pre className="max-h-[70vh] overflow-auto border-t border-line px-4 py-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-dim">{r.log}</pre>
                </details>
            )}
        </div>
    )
}

function LiveLog({ log }: { log: string }) {
    const ref = useRef<HTMLPreElement>(null)
    const pinned = useRef(true)
    useEffect(() => {
        const el = ref.current
        if (el && pinned.current) el.scrollTop = el.scrollHeight
    }, [log])
    return (
        <section className="mt-6">
            <span className="label flex items-center gap-2">
                <span className="size-1.5 animate-pulse rounded-full bg-amber-400" /> Live log
            </span>
            <pre ref={ref} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}
                className="mt-2 max-h-[60vh] overflow-auto rounded-lg border border-line bg-panel/60 px-4 py-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-dim">
                {log || 'Waiting for output…'}
            </pre>
            <p className="mt-1 text-[11px] text-muted">The runner&apos;s own output, refreshed every few seconds. Claude&apos;s work shows up in the notes and report as it records them.</p>
        </section>
    )
}

function Gallery({ files }: { files: { path: string; size: number }[] }) {
    const [open, setOpen] = useState<number | null>(null)
    const src = (p: string) => `/media/${p.split('/').map(encodeURIComponent).join('/')}`
    const isVideo = (p: string) => /\.(mp4|webm)$/i.test(p)
    useEffect(() => {
        if (open === null) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(null)
            if (e.key === 'ArrowRight') setOpen((i) => (i === null ? i : Math.min(files.length - 1, i + 1)))
            if (e.key === 'ArrowLeft') setOpen((i) => (i === null ? i : Math.max(0, i - 1)))
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [open, files.length])
    const cur = open === null ? null : files[open]
    return (
        <section className="mt-6">
            <span className="label">Frames from that day · {files.length}</span>
            <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
                {files.map((f, i) => (
                    <button key={f.path} onClick={() => setOpen(i)} title={f.path}
                        className="group overflow-hidden rounded-md border border-line bg-panel/40 text-left hover:border-line-strong">
                        {isVideo(f.path)
                            ? <div className="grid aspect-video place-items-center text-muted">▶ video</div>
                            // eslint-disable-next-line @next/next/no-img-element
                            : <img src={src(f.path)} alt={f.path} loading="lazy" className="aspect-video w-full object-cover" />}
                        <div className="truncate px-2 py-1 font-mono text-[10.5px] text-muted group-hover:text-dim">{f.path.split('/').slice(1).join('/')}</div>
                    </button>
                ))}
            </div>
            {cur && (
                <div className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4" onClick={() => setOpen(null)}>
                    <div className="mb-2 flex items-center gap-3 font-mono text-[12px] text-dim" onClick={(e) => e.stopPropagation()}>
                        <span className="truncate">{cur.path}</span>
                        <span className="text-muted">{open! + 1} / {files.length} · ← → · Esc</span>
                        <a href={src(cur.path)} target="_blank" rel="noreferrer" className="ml-auto hover:text-fg">open ↗</a>
                    </div>
                    <div className="flex min-h-0 flex-1 items-center justify-center">
                        {isVideo(cur.path)
                            ? <video src={src(cur.path)} controls className="max-h-full max-w-full" onClick={(e) => e.stopPropagation()} />
                            // eslint-disable-next-line @next/next/no-img-element
                            : <img src={src(cur.path)} alt={cur.path} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />}
                    </div>
                </div>
            )}
        </section>
    )
}
