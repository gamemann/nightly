'use client'
import { api } from '~/trpc/react'
import { Empty, Err, Pill, TH, ago } from '../ui/Page'

/** Project tab: crash groups of one project (slug = game slug). Full editing stays on /crashes. */
export function CrashesTab({ projectSlug }: { projectSlug: string }) {
    const d = api.feed.crashes.useQuery({ page: 1, size: 100, sort: 'count', dir: 'desc', f: { game: projectSlug } })
    const rows = d.data?.page.rows ?? []
    return (
        <div>
            <Err e={d.error} />
            {d.data && rows.length === 0 && <Empty>No crashes recorded for {projectSlug}.</Empty>}
            {rows.length > 0 && (
                <table className="w-full text-[12px]">
                    <thead className="text-muted"><tr><TH>Signature</TH><TH>Version</TH><TH>Platform</TH><TH right>Count</TH><TH>Status</TH><TH>Last</TH></tr></thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={r.id} className="border-t border-line hover:bg-hover/40" title={r.sample}>
                                <td className="max-w-md truncate px-2 py-1.5 font-mono">{r.signature}</td><td className="px-2 py-1.5 text-dim">{r.version}</td><td className="px-2 py-1.5 text-dim">{r.platform}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{r.count}</td><td className="px-2 py-1.5"><Pill v={r.status === 'open' ? 'flagged' : r.status} /></td><td className="px-2 py-1.5 text-dim">{ago(new Date(r.at).getTime())}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    )
}
