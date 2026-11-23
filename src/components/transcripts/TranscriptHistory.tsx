'use client'
import Link from 'next/link'
import { Pagination, useUrlParams } from '~/components/Pagination'
import { Card, ErrorLine, Table, when } from '~/components/shell/form'
import { EmptyState, PageHeader } from '~/components/shell/ui'
import { can } from '../../../lib/permissions.mjs'
import { api } from '~/trpc/react'

const DAYS = [1, 7, 30, 90, 0]
const usd = (n: number) => `$${n.toFixed(2)}`

/**
 * /transcripts: agent sessions from the usage index, newest first. ?session=<id> opens one session's
 * summary on top. EXTENSION POINT (phase 2): the full transcript reader and "continue" for a session.
 */
export function TranscriptHistory() {
    const { sp, set } = useUrlParams()
    const days = sp.get('days') != null ? Number(sp.get('days')) : 30
    const page = Number(sp.get('page') ?? 1) || 1
    const size = Number(sp.get('size') ?? 100) || 100
    const project = sp.get('project') ?? ''
    const session = sp.get('session') ?? ''
    const me = api.account.me.useQuery()
    const list = api.usage.sessions.useQuery({ days, page, size, ...(project ? { filter: { project } } : {}) })
    const one = api.usage.sessions.useQuery({ days: 0, page: 1, size: 1, filter: { session } }, { enabled: !!session })
    const picked = one.data?.rows[0]
    return (
        <div>
            <PageHeader title="Transcripts" sub="Agent sessions, newest first."
                actions={can(me.data?.perms, 'transcripts.run') && <Link className="btn-primary" href="/transcripts/new">New transcript</Link>} />
            <div className="space-y-4 p-6">
                {session && (
                    <Card title={<>Session <span className="font-mono text-[12px]">{session}</span></>} actions={<button className="btn" onClick={() => set({ session: '' })}>Close</button>}>
                        <ErrorLine error={one.error} />
                        {one.data === null && <p className="text-[13px] text-dim">Usage data is not configured.</p>}
                        {one.data && !picked && <p className="text-[13px] text-dim">No such session in the usage index.</p>}
                        {picked && (
                            <dl className="grid grid-cols-[9rem_1fr] gap-y-1 text-[13px]">
                                <dt className="text-muted">Project</dt><dd>{picked.project || '-'}</dd>
                                <dt className="text-muted">Branch</dt><dd>{picked.branch || '-'}</dd>
                                <dt className="text-muted">Started</dt><dd>{when(picked.first)}</dd>
                                <dt className="text-muted">Last message</dt><dd>{when(picked.last)}</dd>
                                <dt className="text-muted">Messages</dt><dd>{picked.messages.toLocaleString('en-GB')} (+{picked.subMessages.toLocaleString('en-GB')} subagent)</dd>
                                <dt className="text-muted">Compactions</dt><dd>{picked.compactions}</dd>
                                <dt className="text-muted">Cost</dt><dd>{usd(picked.cost)}</dd>
                            </dl>
                        )}
                        <p className="mt-3 text-[12px] text-muted">The transcript reader lands in phase 2.</p>
                    </Card>
                )}
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                    {DAYS.map((d) => (
                        <button key={d} onClick={() => set({ days: d === 30 ? '' : String(d) })} className={`rounded px-2 py-1 ${d === days ? 'nav-active' : 'text-dim hover:bg-hover/60'}`}>{d ? `${d}d` : 'all'}</button>
                    ))}
                    <input className="input ml-2 w-48" placeholder="project" defaultValue={project} onKeyDown={(e) => { if (e.key === 'Enter') set({ project: (e.target as HTMLInputElement).value.trim() }) }} />
                </div>
                <ErrorLine error={list.error} />
                {list.data === null && <EmptyState title="No usage data">Usage ingestion is not configured on this workspace (AdminCP &gt; Settings).</EmptyState>}
                {list.data && !list.data.total && <EmptyState title="No sessions">No agent sessions in this period.</EmptyState>}
                {!!list.data?.total && (
                    <div className="glow-card p-3">
                        <Table head={['Last message', 'Project', 'Branch', 'Messages', 'Cost', 'Session']}>
                            {list.data.rows.map((r) => (
                                <tr key={r.key} className={r.key === session ? 'bg-accent/10' : undefined}>
                                    <td className="whitespace-nowrap">{when(r.last)}</td><td>{r.project || '-'}</td><td className="text-dim">{r.branch || '-'}</td>
                                    <td className="tabular-nums">{r.messages.toLocaleString('en-GB')}</td><td className="tabular-nums">{usd(r.cost)}</td>
                                    <td><button className="font-mono text-[11.5px] text-accent hover:underline" onClick={() => set({ session: r.key, page: String(page) })}>{r.key.slice(0, 8)}</button></td>
                                </tr>
                            ))}
                        </Table>
                        <Pagination p={list.data} />
                    </div>
                )}
            </div>
        </div>
    )
}
