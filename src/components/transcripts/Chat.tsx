'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '~/trpc/react'
import { ago } from '~/components/pills'
import { Entries, type Child } from './Blocks'
import { Collab } from './Collab'
import { Composer, DEFAULT_OPTS, type Opts } from './Composer'
import { baseName, tokens, type Entry } from './types'

type Live = { text: string; thinking: string }

/** One conversation: history from the session file, live deltas from the SSE stream, a composer to continue it. */
export function Chat({ id }: { id: number }) {
    const utils = api.useUtils()
    const conv = api.transcripts.get.useQuery({ id }, { refetchInterval: 15_000 })
    const tree = api.transcripts.tree.useQuery({ id }, { refetchInterval: 20_000 })
    const [entries, setEntries] = useState<Entry[]>([])
    const [more, setMore] = useState(false)
    const [live, setLive] = useState<Live>({ text: '', thinking: '' })
    const [turn, setTurn] = useState<'idle' | 'working'>('idle')
    const [opts, setOpts] = useState<Opts>(DEFAULT_OPTS)
    const [view, setView] = useState<'chat' | 'collab'>('chat')
    const [err, setErr] = useState('')
    const scroller = useRef<HTMLDivElement>(null)
    const stick = useRef(true)
    const last = useRef(0)

    const merge = useCallback((add: Entry[]) => {
        if (!add.length) return
        setEntries((cur) => {
            const m = new Map(cur.map((e) => [e.seq, e]))
            for (const e of add) m.set(e.seq, e)
            return [...m.values()].sort((a, b) => a.seq - b.seq)
        })
        last.current = Math.max(last.current, ...add.map((e) => e.seq))
    }, [])

    const catchUp = useCallback(async () => {
        const r = await utils.transcripts.messages.fetch({ id, after: last.current, limit: 200 })
        merge(r.entries as Entry[])
        setLive({ text: '', thinking: '' })
    }, [id, merge, utils])

    useEffect(() => {
        setEntries([]); setMore(false); setLive({ text: '', thinking: '' }); setTurn('idle'); setErr(''); last.current = 0; stick.current = true
        let dead = false
        void utils.transcripts.messages.fetch({ id, limit: 60 }).then((r) => {
            if (dead) return
            setEntries(r.entries as Entry[]); setMore(r.hasMore)
            last.current = Math.max(0, ...r.entries.map((e) => e.seq))
        }).catch((e: Error) => setErr(e.message))
        const es = new EventSource(`/api/transcripts/stream?id=${id}`)
        es.addEventListener('changed', () => void catchUp())
        es.addEventListener('delta', (ev) => {
            const d = JSON.parse((ev as MessageEvent).data) as { kind: string; text: string }
            setTurn('working')
            setLive((l) => (d.kind === 'thinking' ? { ...l, thinking: l.thinking + d.text } : { ...l, text: l.text + d.text }))
        })
        es.addEventListener('turn', (ev) => {
            const d = JSON.parse((ev as MessageEvent).data) as { state: string }
            setTurn(d.state === 'running' ? 'working' : 'idle')
            if (d.state !== 'running') { void catchUp(); void conv.refetch(); void utils.transcripts.list.invalidate() }
        })
        es.addEventListener('run', () => void conv.refetch())
        return () => { dead = true; es.close() }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id])

    useEffect(() => {
        const el = scroller.current
        if (el && stick.current) el.scrollTop = el.scrollHeight
    }, [entries, live])

    const earlier = async () => {
        const first = entries[0]?.seq
        if (first === undefined) return
        const el = scroller.current, h = el?.scrollHeight ?? 0
        const r = await utils.transcripts.messages.fetch({ id, before: first, limit: 80 })
        setEntries((cur) => [...(r.entries as Entry[]), ...cur]); setMore(r.hasMore)
        requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - h })
    }

    const send = api.transcripts.send.useMutation({ onError: (e) => setErr(e.message), onSuccess: (r) => { setTurn('working'); void conv.refetch(); if (r.transcriptId !== id) location.assign(`/transcripts/${r.transcriptId}`) } })
    const stop = api.transcripts.stop.useMutation({ onSuccess: () => { void conv.refetch() } })

    const c = conv.data
    const kids = (tree.data?.nodes ?? []).filter((n) => n.id !== id && (n as { parentId: number | null }).parentId === id) as unknown as Child[]
    const running = !!c?.run || turn === 'working'
    if (conv.error) return <div className="p-6 text-sm text-red-300">{conv.error.message}</div>

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-3 border-b border-line px-4 py-2">
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{c?.title || c?.description || 'Conversation'}</div>
                    <div className="truncate font-mono text-[11px] text-muted">{c ? `${baseName(c.cwd)} · ${c.osUser} · ${c.model || 'model unknown'} · ${c.messageCount} msgs · ${tokens(c.outTokens)} out · ${ago(c.lastAt)}` : ''}</div>
                </div>
                {running && <span className="animate-pulse rounded bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">working</span>}
                <div className="flex overflow-hidden rounded-md border border-line text-[12px]">
                    {(['chat', 'collab'] as const).map((v) => <button key={v} onClick={() => setView(v)} className={`px-2.5 py-1 ${view === v ? 'bg-hover text-fg' : 'text-dim hover:text-fg'}`}>{v === 'chat' ? 'Chat' : `Collaboration${kids.length ? ` (${kids.length})` : ''}`}</button>)}
                </div>
            </div>
            {view === 'collab' ? (
                <div className="min-h-0 flex-1 overflow-auto p-4">{tree.data ? <Collab nodes={tree.data.nodes as never} current={id} /> : <div className="text-muted">loading…</div>}</div>
            ) : (
                <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }} className="min-h-0 flex-1 overflow-auto">
                    <div className="mx-auto max-w-4xl px-4 py-4">
                        {more && <button className="btn mb-3 w-full" onClick={() => void earlier()}>Load earlier messages</button>}
                        {err && <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[12px] text-red-200">{err}</div>}
                        <Entries entries={entries} children={kids} live={(live.text || live.thinking) ? (
                            <div className="py-1">
                                {live.thinking && <div className="mb-1 whitespace-pre-wrap border-l border-line-strong pl-3 text-[12px] italic text-muted">{live.thinking.slice(-600)}</div>}
                                {live.text && <div className="md whitespace-pre-wrap text-[13px]">{live.text}<span className="animate-pulse">▍</span></div>}
                            </div>
                        ) : running ? <div className="py-2 text-[12px] text-muted animate-pulse">Claude is working…</div> : null} />
                        {!entries.length && !err && !running && <div className="py-10 text-center text-muted">No messages yet.</div>}
                    </div>
                </div>
            )}
            {c?.canRun ? (
                <Composer
                    opts={opts} setOpts={setOpts} busy={running} disabled={send.isPending}
                    hint={c.status === 'running' && !c.run ? 'Recently active elsewhere: replying starts a fork so an open editor window is not disturbed' : undefined}
                    onSend={async (text) => { setErr(''); await send.mutateAsync({ id, text, model: opts.model || undefined, effort: (opts.effort || undefined) as never, mode: opts.mode as never }) }}
                    onInterrupt={() => stop.mutate({ id, interrupt: true })} onStop={() => stop.mutate({ id })}
                />
            ) : <div className="border-t border-line p-3 text-center text-[12px] text-muted">Read-only: you need the transcripts.run permission and node access to continue a conversation.</div>}
        </div>
    )
}
