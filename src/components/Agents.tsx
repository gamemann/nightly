'use client'
import { useEffect, useRef, useState } from 'react'
import { api, type RouterOutputs } from '~/trpc/react'
import { ago } from './pills'

type Board = RouterOutputs['agent']['board']
type Agent = Board['live'][number]

const time = (d: Date | string) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const dayOf = (d: Date | string) => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })
const KIND_DOT: Record<string, string> = { nightly: 'bg-accent', session: 'bg-teal-400' }

export function Agents() {
    const board = api.agent.board.useQuery(undefined, { refetchInterval: 4000 })
    const b = board.data
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <h1 className="text-[15px] font-semibold tracking-tight">
                Agents<span className="ml-2 text-[12px] font-normal tabular-nums text-muted">{b ? `${b.live.length} live` : ''}</span>
            </h1>
            <p className="mt-0.5 mb-4 text-[12px] text-muted">
                Claude sessions working in the workspace right now: what each is on, which paths it holds, and what they tell each other.
                Agents use <code className="font-mono">nightly agent join · claim · say · inbox · leave</code>; a claim on a path another live agent holds is refused.
            </p>
            {board.isLoading && <div className="p-6 text-center text-muted">Loading…</div>}
            {b && (
                <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-5 max-lg:grid-cols-1">
                    <Feed b={b} />
                    <aside className="space-y-5">
                        <section>
                            <span className="label">Live · {b.live.length}</span>
                            <div className="mt-2 space-y-2">
                                {b.live.length === 0 && <div className="rounded-lg border border-line px-3 py-4 text-center text-[12px] text-muted">Nobody is on the board.</div>}
                                {b.live.map((a) => <AgentCard key={a.id} a={a} claims={b.claims.filter((c) => c.agentId === a.id)} />)}
                            </div>
                        </section>
                        {b.quiet.length > 0 && (
                            <section>
                                <span className="label">Gone quiet · {b.quiet.length}</span>
                                <p className="mt-1 text-[11px] text-muted">Silent for over an hour without leaving. Their claims no longer block; they are ended after 6 h.</p>
                                <div className="mt-2 space-y-2">
                                    {b.quiet.map((a) => <AgentCard key={a.id} a={a} claims={b.claims.filter((c) => c.agentId === a.id)} quiet />)}
                                </div>
                            </section>
                        )}
                        {b.ended.length > 0 && (
                            <section>
                                <span className="label">Left today</span>
                                <ul className="mt-2 space-y-1 text-[12px]">
                                    {b.ended.map((a) => (
                                        <li key={a.id} className="flex items-center gap-2 text-muted">
                                            <span className="size-1.5 rounded-full bg-zinc-600" />
                                            <span className="font-mono text-dim">{a.name}</span>
                                            <span className="min-w-0 flex-1 truncate">{a.task}</span>
                                            <span className="shrink-0 text-[11px]">{a.endedAt && ago(a.endedAt)}</span>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        )}
                    </aside>
                </div>
            )}
        </div>
    )
}

function AgentCard({ a, claims, quiet }: { a: Agent; claims: Board['claims']; quiet?: boolean }) {
    const utils = api.useUtils()
    const release = api.agent.release.useMutation({ onSuccess: () => utils.agent.board.invalidate() })
    const end = api.agent.end.useMutation({ onSuccess: () => Promise.all([utils.agent.board.invalidate(), utils.agent.liveCount.invalidate()]) })
    return (
        <div className={`rounded-lg border border-line bg-panel/50 px-3 py-2.5 ${quiet ? 'opacity-70' : ''}`}>
            <div className="flex items-center gap-2">
                <span className={`size-2 shrink-0 rounded-full ${quiet ? 'bg-zinc-500' : KIND_DOT[a.kind] ?? 'bg-teal-400'} ${quiet ? '' : 'shadow-[0_0_6px] shadow-current'}`} />
                <span className="truncate font-mono text-[12.5px] text-fg">{a.name}</span>
                <span className="text-[10.5px] text-muted">{a.kind}{a.runId ? ` · run #${a.runId}` : ''}</span>
                <span className="ml-auto shrink-0 text-[10.5px] text-muted" title={`joined ${ago(a.startedAt)}`}>{ago(a.lastSeenAt)}</span>
            </div>
            {a.task && <p className="mt-1 text-[12px] text-dim">{a.task}</p>}
            {claims.length > 0 && (
                <ul className="mt-2 space-y-1">
                    {claims.map((c) => (
                        <li key={c.id} className="group flex items-center gap-1.5 text-[11.5px]">
                            <span className="text-[10px] text-muted">holds</span>
                            <span className="truncate rounded border border-line bg-panel-2 px-1.5 py-px font-mono text-dim" title={c.note || undefined}>{c.scope}</span>
                            <span className="shrink-0 text-[10.5px] text-muted">{ago(c.createdAt)}</span>
                            <button className="ml-auto hidden text-[10.5px] text-muted group-hover:inline hover:text-red-300" disabled={release.isPending}
                                onClick={() => confirm(`Release ${a.name}'s claim on ${c.scope}? It will not be told.`) && release.mutate({ id: c.id })}>release</button>
                        </li>
                    ))}
                </ul>
            )}
            {quiet && (
                <button className="mt-2 text-[11px] text-muted hover:text-red-300" disabled={end.isPending}
                    onClick={() => confirm(`End ${a.name}? Its claims are released.`) && end.mutate({ id: a.id })}>end session</button>
            )}
        </div>
    )
}

function Feed({ b }: { b: Board }) {
    const utils = api.useUtils()
    const [body, setBody] = useState('')
    const [to, setTo] = useState('')
    const [hideBoard, setHideBoard] = useState(false)
    const post = api.agent.post.useMutation({ onSuccess: () => { setBody(''); return utils.agent.board.invalidate() } })
    const ref = useRef<HTMLDivElement>(null)
    const pinned = useRef(true)
    const msgs = hideBoard ? b.messages.filter((m) => m.author !== 'board') : b.messages
    const last = msgs.at(-1)?.id
    useEffect(() => {
        const el = ref.current
        if (el && pinned.current) el.scrollTop = el.scrollHeight
    }, [last])
    const send = () => body.trim() && post.mutate({ body: body.trim(), to: to || undefined })
    let prevDay = ''
    return (
        <section className="flex min-h-[420px] flex-col overflow-hidden rounded-lg border border-line bg-panel/40 lg:h-[calc(100vh-150px)]">
            <div className="flex items-center gap-3 border-b border-line px-3 py-2">
                <span className="label">Messages</span>
                <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
                    <input type="checkbox" checked={hideBoard} onChange={(e) => setHideBoard(e.target.checked)} /> hide joins &amp; claims
                </label>
            </div>
            <div ref={ref} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }}
                className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-3 max-lg:max-h-[60vh]">
                {msgs.length === 0 && <div className="py-10 text-center text-[12px] text-muted">No messages yet.</div>}
                {msgs.map((m) => {
                    const d = dayOf(m.createdAt)
                    const sep = d !== prevDay ? (prevDay = d) : null
                    const sys = m.author === 'board'
                    const me = m.author === 'christian'
                    return (
                        <div key={m.id}>
                            {sep && <div className="my-2 text-center text-[10.5px] text-muted">{sep}</div>}
                            {sys ? (
                                <div className="flex gap-2 pl-1 text-[11.5px] text-muted">
                                    <span className="w-10 shrink-0 tabular-nums">{time(m.createdAt)}</span>
                                    <span>{m.body}</span>
                                </div>
                            ) : (
                                <div className={`flex gap-2 rounded-md px-1 py-1 ${m.to ? 'bg-panel-2/60' : ''}`}>
                                    <span className="w-10 shrink-0 pt-px text-[11px] tabular-nums text-muted">{time(m.createdAt)}</span>
                                    <div className="min-w-0">
                                        <span className={`font-mono text-[12px] ${me ? 'text-accent' : 'text-teal-300'}`}>{m.author}</span>
                                        {m.to && <span className="font-mono text-[12px] text-muted"> → {m.to}</span>}
                                        <p className="whitespace-pre-wrap break-words text-[13px] text-fg/90">{m.body}</p>
                                    </div>
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
            <div className="flex items-end gap-2 border-t border-line p-2">
                <select className="select w-36 shrink-0" value={to} onChange={(e) => setTo(e.target.value)} title="Send to">
                    <option value="">everyone</option>
                    {b.live.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
                </select>
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={1} placeholder="Tell the agents something… (Enter to send)"
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                    className="input min-h-[32px] flex-1 resize-none" />
                <button className="btn-primary" disabled={!body.trim() || post.isPending} onClick={send}>Send</button>
            </div>
            {post.error && <p className="px-3 pb-2 text-[12px] text-red-300">{post.error.message}</p>}
        </section>
    )
}
