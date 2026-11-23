'use client'
import Link from 'next/link'
import { useState } from 'react'
import { api } from '~/trpc/react'
import { Empty, Err, Pill, TH, ago } from '../ui/Page'

const when = (d: Date | number) => new Date(d).toISOString().slice(0, 16).replace('T', ' ')
const live = (s: string) => s === 'queued' || s === 'running'

/** Trigger a playtest (Planet or Station) and watch its status and log. Perf runs and playtests are linked (a bot playtest is the perf run's twin).
 *  `project` pins the game (project tab); without it the game is chosen here. */
export function PlaytestPanel({ project }: { project?: string }) {
    const utils = api.useUtils()
    const games = api.ops.links.games.useQuery(undefined, { enabled: !project })
    const [game, setGame] = useState('')
    const g = project ?? (game || games.data?.[0]?.slug || '')
    const jobs = api.ops.offload.list.useQuery({ project: g || undefined }, { refetchInterval: 5_000 })
    const links = api.ops.links.forGame.useQuery({ game: g || undefined }, { refetchInterval: 30_000 })
    const [f, setF] = useState({ target: 'planet' as 'planet' | 'station', map: '', bots: 4, duration: 60 })
    const [open, setOpen] = useState<number | null>(null)
    const job = api.ops.offload.job.useQuery({ id: open ?? 0 }, { enabled: open !== null, refetchInterval: (q) => (q.state.data && live(q.state.data.status) ? 3_000 : false) })
    const trigger = api.ops.offload.trigger.useMutation({ onSuccess: (r) => { setOpen(r.id); utils.ops.offload.list.invalidate() } })
    const may = jobs.data?.mayTrigger ?? false
    return (
        <div>
            <Err e={trigger.error ?? jobs.error ?? links.error} />
            <section className="mb-5 rounded-lg border border-line bg-panel/40 p-3">
                <h2 className="mb-2 text-[12px] font-medium text-dim">Trigger playtest</h2>
                <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (g) trigger.mutate({ project: g, ...f }) }}>
                    {!project && (
                        <label className="text-[11px] text-muted">Game<select className="select mt-0.5 block" value={g} onChange={(e) => setGame(e.target.value)}>{games.data?.map((x) => <option key={x.slug} value={x.slug}>{x.name || x.slug}</option>)}</select></label>
                    )}
                    <label className="text-[11px] text-muted">Target<select className="select mt-0.5 block" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value as 'planet' | 'station' })}><option value="planet">Planet</option><option value="station">Station</option></select></label>
                    <label className="text-[11px] text-muted">Map<input className="input mt-0.5 block w-36" value={f.map} placeholder="default" onChange={(e) => setF({ ...f, map: e.target.value })} /></label>
                    <label className="text-[11px] text-muted">Bots<input className="input mt-0.5 block w-20" type="number" min={1} max={64} value={f.bots} onChange={(e) => setF({ ...f, bots: Number(e.target.value) })} /></label>
                    <label className="text-[11px] text-muted">Seconds<input className="input mt-0.5 block w-24" type="number" min={10} max={3600} value={f.duration} onChange={(e) => setF({ ...f, duration: Number(e.target.value) })} /></label>
                    <button className="btn-primary btn" disabled={!may || !g || trigger.isPending} title={may ? '' : 'needs permission playtest.trigger'}>{trigger.isPending ? 'Starting...' : 'Trigger playtest'}</button>
                    {!may && jobs.data && <span className="text-[11px] text-amber-300">You lack playtest.trigger{g ? ` on ${g}` : ''}.</span>}
                </form>
                <p className="mt-2 text-[11px] text-muted">Runs the project&apos;s <code>tools/playtest.sh</code> on a free node and records a bot playtest plus its perf run (linked below).</p>
            </section>

            <h2 className="mb-1 text-[12px] font-medium text-dim">Jobs</h2>
            {jobs.data?.jobs.length === 0 && <Empty>No playtest jobs yet.</Empty>}
            {!!jobs.data?.jobs.length && (
                <table className="mb-3 w-full text-[12px]">
                    <thead className="text-muted"><tr><TH>#</TH><TH>Kind</TH><TH>Target</TH><TH>Node</TH><TH>Status</TH><TH>By</TH><TH>Queued</TH><TH>Result</TH></tr></thead>
                    <tbody>
                        {jobs.data.jobs.map((j) => (
                            <tr key={j.id} className={`cursor-pointer border-t border-line hover:bg-hover/40 ${open === j.id ? 'bg-hover/30' : ''}`} onClick={() => setOpen(open === j.id ? null : j.id)}>
                                <td className="px-2 py-1.5 font-mono">{j.id}</td><td className="px-2 py-1.5">{j.kind}</td><td className="px-2 py-1.5">{j.target}</td><td className="px-2 py-1.5 text-dim">{j.node || '-'}</td>
                                <td className="px-2 py-1.5"><Pill v={j.status} /></td><td className="px-2 py-1.5 text-dim">{j.requestedBy || '-'}</td><td className="px-2 py-1.5 text-dim">{ago(j.createdAt)}</td>
                                <td className="max-w-xs truncate px-2 py-1.5 text-dim">{j.result}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {open !== null && job.data && (
                <div className="mb-5 rounded-lg border border-line bg-panel/40 p-3">
                    <div className="mb-1 text-[12px] text-dim">Job #{job.data.id} <Pill v={job.data.status} /> <span className="ml-2 text-muted">{job.data.params}</span></div>
                    <pre className="max-h-80 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-dim">{job.data.log || '(no output yet)'}</pre>
                </div>
            )}

            <h2 className="mb-1 text-[12px] font-medium text-dim">Playtests and their perf runs</h2>
            {links.data && links.data.playtests.length === 0 && <Empty>No playtests recorded.</Empty>}
            {!!links.data?.playtests.length && (
                <table className="mb-5 w-full text-[12px]">
                    <thead className="text-muted"><tr><TH>When</TH><TH>Game</TH><TH>Build</TH><TH>Tester</TH><TH>Rating</TH><TH>Perf run</TH><TH>Notes</TH></tr></thead>
                    <tbody>
                        {links.data.playtests.map((t) => (
                            <tr key={t.id} className="border-t border-line hover:bg-hover/40">
                                <td className="px-2 py-1.5 text-dim">{when(t.at)}</td><td className="px-2 py-1.5">{t.game}</td><td className="px-2 py-1.5 font-mono text-dim">{t.build}</td>
                                <td className="px-2 py-1.5">{t.tester}{t.automatic && <span className="ml-1.5 rounded bg-sky-400/15 px-1 text-[10px] text-sky-300">automatic</span>}</td>
                                <td className="px-2 py-1.5">{t.rating || '-'}</td>
                                <td className="px-2 py-1.5">{t.perfRunId ? <Link className="text-accent hover:underline" href={`/tools/perf/${t.game}/run/${t.perfRunId}`}>run #{t.perfRunId}</Link> : '-'}</td>
                                <td className="max-w-sm truncate px-2 py-1.5 text-dim" title={t.text}>{t.text}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <h2 className="mb-1 text-[12px] font-medium text-dim">Perf runs</h2>
            {links.data && links.data.perf.length === 0 && <Empty>No perf runs.</Empty>}
            {!!links.data?.perf.length && (
                <table className="w-full text-[12px]">
                    <thead className="text-muted"><tr><TH>When</TH><TH>Game</TH><TH>Scope</TH><TH>Commit</TH><TH>Playtest</TH></tr></thead>
                    <tbody>
                        {links.data.perf.map((r) => (
                            <tr key={r.id} className="border-t border-line hover:bg-hover/40">
                                <td className="px-2 py-1.5 text-dim">{when(r.ranAt)}</td>
                                <td className="px-2 py-1.5"><Link className="text-accent hover:underline" href={`/tools/perf/${r.game}/run/${r.id}`}>{r.game} #{r.id}</Link></td>
                                <td className="px-2 py-1.5 text-dim">{r.platform}{r.map ? ` ${r.map}` : ''}{r.bots ? ` ${r.bots}b` : ''}</td>
                                <td className="px-2 py-1.5 font-mono text-dim">{String(r.commit).slice(0, 8)}</td>
                                <td className="px-2 py-1.5">{r.playtestId ? <span className="text-sky-300">playtest #{r.playtestId}</span> : '-'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    )
}
