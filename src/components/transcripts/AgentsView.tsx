'use client'
import Link from 'next/link'
import { useState } from 'react'
import { api } from '~/trpc/react'
import { ago } from '~/components/pills'
import { short, tokens } from './types'

export function AgentsView({ embedded = false }: { embedded?: boolean }) {
    const [q, setQ] = useState('')
    const a = api.transcripts.agents.useQuery({ q }, { refetchInterval: 15_000, placeholderData: (p) => p })
    return (
        <div className={embedded ? 'p-6' : 'h-full overflow-auto p-6'}>
            <div className="mx-auto max-w-5xl space-y-6">
                <div className="flex items-center gap-3"><h1 className="text-lg font-semibold">Agents</h1><input className="input ml-auto w-64 text-[12px]" placeholder="Search agents and parents" value={q} onChange={(e) => setQ(e.target.value)} /></div>
                {a.data?.registered.length ? (
                    <section>
                        <div className="label mb-2">Registered</div>
                        <div className="grid gap-2 sm:grid-cols-2">{a.data.registered.map((r) => (
                            <Link key={String(r.name)} href="/agents" className="rounded-lg border border-line bg-panel p-2.5 hover:bg-hover">
                                <div className="flex items-center gap-2 text-[13px]"><span className="font-medium">{String(r.name)}</span><span className="text-[11px] text-muted">{String(r.status)}</span><span className="ml-auto text-[11px] text-muted">{ago(String(r.updatedAt))}</span></div>
                                <div className="truncate text-[12px] text-dim">{String(r.task ?? '')}</div>
                            </Link>))}</div>
                    </section>
                ) : null}
                <section>
                    <div className="label mb-2">Subagent threads</div>
                    <div className="overflow-hidden rounded-lg border border-line bg-panel">
                        {a.error && <div className="p-3 text-[12px] text-red-300">{a.error.message}</div>}
                        {a.data?.threads.map((t) => (
                            <Link key={t.id} href={`/transcripts/${t.id}`} className="flex items-center gap-3 border-b border-line/60 px-3 py-2 text-[12px] last:border-0 hover:bg-hover">
                                <span className="w-28 shrink-0 truncate font-medium text-accent">{String(t.agentType) || 'agent'}</span>
                                <span className="min-w-0 flex-1 truncate text-dim">{short(String(t.description) || '(no description)', 120)}</span>
                                <span className="hidden w-48 truncate text-muted md:block" title="Parent conversation">{t.parentTitle ? short(String(t.parentTitle), 40) : ''}</span>
                                <span className="w-24 text-right text-muted">{t.messageCount} msgs · {tokens(t.outTokens)}</span>
                                <span className="w-14 text-right text-muted">{ago(String(t.lastAt))}</span>
                            </Link>
                        ))}
                        {a.data && !a.data.threads.length && <div className="p-4 text-center text-[12px] text-muted">No subagent threads.</div>}
                    </div>
                </section>
            </div>
        </div>
    )
}
