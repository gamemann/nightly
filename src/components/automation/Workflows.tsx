'use client'
import { useState } from 'react'
import { api } from '~/trpc/react'
import { Empty, Err, Page, Pill, TH, ago } from '../ui/Page'
import { AUTOMATION_TABS } from './tabs'

/** CI workflows and their runs per accessible project: Forgejo first, GitHub through the rate-limited gh wrapper, cached by the CLI (`nightly ci sync`).
 *  Re-run and cancel need automation.edit and only exist for GitHub runs (Forgejo is read-only here). */
export function Workflows({ projectSlug, embedded }: { projectSlug?: string; embedded?: boolean }) {
    const [project, setProject] = useState(projectSlug ?? '')
    const [status, setStatus] = useState('')
    const utils = api.useUtils()
    const games = api.ops.links.games.useQuery(undefined, { enabled: !projectSlug })
    const repos = api.ops.ci.repos.useQuery()
    const runs = api.ops.ci.runs.useQuery({ project: project || undefined, status: status || undefined, limit: 150 }, { refetchInterval: 30_000 })
    const done = () => { utils.ops.ci.runs.invalidate(); utils.ops.ci.repos.invalidate() }
    const sync = api.ops.ci.sync.useMutation({ onSuccess: done })
    const act = api.ops.ci.act.useMutation({ onSuccess: done })
    const stale = repos.data?.repos.filter((r) => r.error) ?? []
    const mayAct = repos.data?.mayAct ?? false
    return (
        <Page embedded={embedded} title="Workflows" tabs={embedded ? undefined : AUTOMATION_TABS} hint="CI runs from Forgejo (first) or GitHub, cached; GitHub calls go through the rate-limited wrapper (Usage, GitHub API)."
            actions={<>
                {!projectSlug && (
                    <select className="select" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
                        <option value="">All projects</option>{games.data?.map((g) => <option key={g.slug} value={g.slug}>{g.name || g.slug}</option>)}
                    </select>
                )}
                <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
                    <option value="">Any status</option>{['success', 'failure', 'running', 'cancelled', 'queued'].map((s) => <option key={s}>{s}</option>)}
                </select>
                <button className="btn" disabled={sync.isPending} onClick={() => sync.mutate({ repo: undefined, force: true })}>{sync.isPending ? 'Syncing...' : 'Sync now'}</button>
            </>}>
            <Err e={sync.error ?? act.error ?? runs.error} />
            {stale.length > 0 && <div className="mb-3 rounded border border-amber-400/40 p-2 text-[12px] text-amber-300">{stale.length} repo(s) could not be refreshed: {stale.map((r) => `${r.repo} (${r.error.slice(0, 80)})`).join('; ')}</div>}
            {runs.isLoading && <div className="p-6 text-center text-muted">Loading...</div>}
            {runs.data && runs.data.length === 0 && <Empty>No cached runs{project ? ` for ${project}` : ''}. Press Sync now, or run <code>nightly ci sync</code>.</Empty>}
            {runs.data && runs.data.length > 0 && (
                <table className="w-full text-[12px]">
                    <thead className="text-muted"><tr><TH>Result</TH><TH>Repo</TH><TH>Workflow</TH><TH>Branch</TH><TH>Commit</TH><TH>Source</TH><TH>When</TH><TH /></tr></thead>
                    <tbody>
                        {runs.data.map((r) => (
                            <tr key={`${r.source}/${r.repo}/${r.runId}`} className="border-t border-line hover:bg-hover/40">
                                <td className="px-2 py-1.5"><Pill v={r.verdict} /></td>
                                <td className="px-2 py-1.5">{r.repo}</td>
                                <td className="px-2 py-1.5" title={r.title}>{r.url ? <a className="hover:text-sky-300" href={r.url} target="_blank" rel="noreferrer">{r.workflow || r.title}</a> : r.workflow}</td>
                                <td className="px-2 py-1.5 font-mono">{r.branch}</td>
                                <td className="px-2 py-1.5 font-mono text-dim">{r.sha}</td>
                                <td className="px-2 py-1.5 text-dim">{r.source}</td>
                                <td className="px-2 py-1.5 text-dim">{ago(r.createdAt)}</td>
                                <td className="px-2 py-1.5 text-right">
                                    {mayAct && r.source === 'github' && (r.verdict === 'running' || r.verdict === 'queued'
                                        ? <button className="text-[12px] text-red-300 hover:underline" disabled={act.isPending} onClick={() => act.mutate({ action: 'cancel', repo: r.repo, runId: r.runId })}>Cancel</button>
                                        : <button className="text-[12px] text-accent hover:underline" disabled={act.isPending} onClick={() => act.mutate({ action: 'rerun', repo: r.repo, runId: r.runId })}>Re-run</button>)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <div className="mt-3 text-[11px] text-muted">{repos.data?.repos.length ?? 0} repos cached{repos.data?.repos.length ? `, oldest refresh ${ago(Math.min(...repos.data.repos.map((r) => r.fetchedAt)))}` : ''}.{!mayAct && ' Re-run and cancel need the automation.edit permission.'}</div>
        </Page>
    )
}
