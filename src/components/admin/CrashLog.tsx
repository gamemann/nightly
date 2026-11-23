import Link from 'next/link'
import type { ReactNode } from 'react'
import { PageHeader } from '~/components/shell/ui'
import { db } from '~/server/db'

// AdminCP > Crash Log: the workspace's own failures, as opposed to game crashes (Game Tools > Crashes).
// Host crashes (OOM-killed builds and suites from `nightly crash scan`, game "dev-host"), runner runs that
// failed or stalled, node jobs and offloaded jobs (playtests, map conversions) that failed. Read-only;
// `nightly crash scan` and the scheduler fill the sources.
const STALL_MS = 6 * 3600_000
type Row = Record<string, unknown>

async function raw(sql: string): Promise<Row[]> {
    try { return (await db.$queryRawUnsafe(sql)) as Row[] } catch { return [] } // table not created yet: empty
}
const when = (d: Date | string | number | null | undefined) => {
    if (d === null || d === undefined || d === '') return '-'
    const t = typeof d === 'number' ? (d < 1e12 ? d * 1000 : d) : new Date(d).getTime()
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : String(d)
}

function Section({ title, count, children, more }: { title: string; count: number; children: ReactNode; more?: ReactNode }) {
    return (
        <section className="glow-card mb-4 p-4">
            <div className="mb-2 flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-semibold">{title} <span className="text-muted">({count})</span></h2>
                {more && <div className="text-[12px]">{more}</div>}
            </div>
            {count === 0 ? <div className="text-[12px] text-muted">Nothing recorded.</div> : <div className="overflow-x-auto">{children}</div>}
        </section>
    )
}
const th = 'px-2 py-1.5 text-left font-normal'
const td = 'px-2 py-1.5 align-top'

export async function CrashLog() {
    const stallBefore = new Date(Date.now() - STALL_MS)
    const [host, runs, jobs, offload, convert] = await Promise.all([
        db.crashGroup.findMany({ where: { game: 'dev-host' }, orderBy: { at: 'desc' }, take: 100 }),
        db.run.findMany({ where: { OR: [{ status: 'failed' }, { status: 'running', startedAt: { lt: stallBefore } }] }, orderBy: { startedAt: 'desc' }, take: 50, select: { id: true, status: true, startedAt: true, summary: true, trigger: true, schedule: { select: { name: true } } } }),
        db.nodeJob.findMany({ where: { status: { in: ['failed', 'error', 'lost'] } }, orderBy: { createdAt: 'desc' }, take: 50 }),
        raw(`SELECT id, kind, project, node, status, created_at, substr(log, -400) AS tail FROM offload_job WHERE status IN ('failed','error','lost') ORDER BY id DESC LIMIT 50`),
        raw(`SELECT id, project, input_name, to_fmt, node, error, created_at FROM map_convert_job WHERE status IN ('failed','error') ORDER BY id DESC LIMIT 50`),
    ])
    const nodes = new Map((await db.node.findMany({ select: { id: true, name: true } })).map((n) => [n.id, n.name]))
    return (
        <div>
            <PageHeader title="Crash Log" sub="Failures of the workspace itself: host OOM kills, runner runs, node and offloaded jobs. Game crashes are under Game Tools." />
            <div className="p-6">
                <Section title="Host crashes" count={host.length} more={<span className="text-muted">Refresh: <code>nightly crash scan</code> · <Link className="text-accent hover:underline" href="/tools/crashes">Game crashes</Link></span>}>
                    <table className="w-full text-[12px]">
                        <thead className="text-muted"><tr><th className={th}>Signature</th><th className={th}>Count</th><th className={th}>Status</th><th className={th}>First</th><th className={th}>Last</th></tr></thead>
                        <tbody>{host.map((c) => (
                            <tr key={c.id} className="border-t border-line" title={c.sample}>
                                <td className={`${td} max-w-xl truncate font-mono`}>{c.signature}</td><td className={`${td} tabular-nums`}>{c.count}</td><td className={td}>{c.status}</td><td className={`${td} text-dim`}>{when(c.firstSeenAt)}</td><td className={`${td} text-dim`}>{when(c.at)}</td>
                            </tr>
                        ))}</tbody>
                    </table>
                </Section>
                <Section title="Runner runs failed or stalled" count={runs.length} more={<Link className="text-accent hover:underline" href="/admin/runs">Runs & reports</Link>}>
                    <table className="w-full text-[12px]">
                        <thead className="text-muted"><tr><th className={th}>Run</th><th className={th}>Schedule</th><th className={th}>State</th><th className={th}>Started</th><th className={th}>Summary</th></tr></thead>
                        <tbody>{runs.map((r) => (
                            <tr key={r.id} className="border-t border-line">
                                <td className={td}><Link className="text-accent hover:underline" href={`/admin/runs/${r.id}`}>#{r.id}</Link></td><td className={td}>{r.schedule?.name ?? r.trigger}</td>
                                <td className={td}>{r.status === 'running' ? <span className="text-amber-300">stalled (running &gt; 6 h)</span> : <span className="text-red-300">failed</span>}</td>
                                <td className={`${td} text-dim`}>{when(r.startedAt)}</td><td className={`${td} max-w-xl truncate text-dim`}>{r.summary}</td>
                            </tr>
                        ))}</tbody>
                    </table>
                </Section>
                <Section title="Node jobs failed" count={jobs.length} more={<Link className="text-accent hover:underline" href="/admin/builds">Builds</Link>}>
                    <table className="w-full text-[12px]">
                        <thead className="text-muted"><tr><th className={th}>Job</th><th className={th}>Kind</th><th className={th}>Node</th><th className={th}>Exit</th><th className={th}>Reason</th><th className={th}>Created</th></tr></thead>
                        <tbody>{jobs.map((j) => (
                            <tr key={j.id} className="border-t border-line" title={j.log.slice(-600)}>
                                <td className={`${td} font-mono`}>{j.name || j.jobKey}</td><td className={td}>{j.kind}{j.heavy ? ' (heavy)' : ''}</td><td className={td}>{(j.nodeId && nodes.get(j.nodeId)) || '-'}</td>
                                <td className={`${td} tabular-nums`}>{j.exitCode ?? '-'}</td><td className={`${td} max-w-md truncate text-dim`}>{j.reason}</td><td className={`${td} text-dim`}>{when(j.createdAt)}</td>
                            </tr>
                        ))}</tbody>
                    </table>
                </Section>
                <Section title="Offloaded jobs failed" count={offload.length + convert.length} more={<Link className="text-accent hover:underline" href="/tools/playtest">Playtest</Link>}>
                    <table className="w-full text-[12px]">
                        <thead className="text-muted"><tr><th className={th}>Job</th><th className={th}>Kind</th><th className={th}>Project</th><th className={th}>Node</th><th className={th}>Detail</th><th className={th}>Created</th></tr></thead>
                        <tbody>
                            {offload.map((o) => (
                                <tr key={`o${String(o.id)}`} className="border-t border-line">
                                    <td className={`${td} font-mono`}>offload #{String(o.id)}</td><td className={td}>{String(o.kind)}</td><td className={td}>{String(o.project)}</td><td className={td}>{String(o.node)}</td>
                                    <td className={`${td} max-w-md truncate font-mono text-dim`}>{String(o.tail ?? '')}</td><td className={`${td} text-dim`}>{when(Number(o.created_at))}</td>
                                </tr>
                            ))}
                            {convert.map((c) => (
                                <tr key={`m${String(c.id)}`} className="border-t border-line">
                                    <td className={`${td} font-mono`}>convert #{String(c.id)}</td><td className={td}>map-conversion ({String(c.to_fmt)})</td><td className={td}>{String(c.project)}</td><td className={td}>{String(c.node || 'local')}</td>
                                    <td className={`${td} max-w-md truncate text-dim`}>{String(c.input_name)}: {String(c.error)}</td><td className={`${td} text-dim`}>{when(String(c.created_at))}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </Section>
            </div>
        </div>
    )
}
