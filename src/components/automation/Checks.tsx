'use client'
import Link from 'next/link'
import { useState } from 'react'
import { api } from '~/trpc/react'
import { isDue } from '~/lib/constants'
import { Empty, Err, Page, Pill, TH, ago } from '../ui/Page'
import { AUTOMATION_TABS } from './tabs'

type Draft = { name: string; isNew: boolean; script: string; args: string; intervalMin: number; enabled: boolean; itemKey: string; note: string }
const blank = (script = ''): Draft => ({ name: script.replace(/^chk-|\.sh$/g, ''), isNew: true, script, args: '', intervalMin: 0, enabled: true, itemKey: '', note: '' })

/** Two kinds of check: queue items of kind=check (an agent performs them; "Run now" makes one due) and scripts/chk-*.sh
 *  (this machine runs them: create, edit, run now, schedule by interval; exit 0 ok, 1 flagged, 2+ unreadable). */
export function Checks() {
    const utils = api.useUtils()
    const list = api.ops.checks.list.useQuery(undefined, { refetchInterval: 20_000 })
    const avail = api.ops.checks.available.useQuery()
    const [open, setOpen] = useState<string | null>(null)
    const runs = api.ops.checks.runs.useQuery({ name: open ?? undefined, limit: 15 }, { enabled: open !== null })
    const [draft, setDraft] = useState<Draft | null>(null)
    const refresh = () => { utils.ops.checks.list.invalidate(); utils.ops.checks.runs.invalidate(); utils.ops.checks.available.invalidate() }
    const save = api.ops.checks.save.useMutation({ onSuccess: () => { setDraft(null); refresh() } })
    const remove = api.ops.checks.remove.useMutation({ onSuccess: () => { setDraft(null); refresh() } })
    const run = api.ops.checks.run.useMutation({ onSuccess: refresh })
    const due = api.ops.checks.due.useMutation({ onSuccess: refresh })
    const may = list.data?.mayEdit ?? false
    const err = save.error ?? remove.error ?? run.error ?? due.error ?? list.error
    const configured = new Set(list.data?.scripts.map((s) => s.script))
    const free = (avail.data ?? []).filter((a) => !configured.has(a.script))
    return (
        <Page title="Checks" tabs={AUTOMATION_TABS} hint="Script checks run here on a schedule; item checks are done by an agent on their cadence."
            actions={may && <button className="btn-primary btn" disabled={!free.length} onClick={() => setDraft(blank(free[0]?.script))}>New script check</button>}>
            <Err e={err} />
            {draft && (
                <form className="mb-4 grid gap-2 rounded-lg border border-line bg-panel/40 p-3 md:grid-cols-4" onSubmit={(e) => { e.preventDefault(); save.mutate(draft) }}>
                    <label className="text-[11px] text-muted">Name<input className="input mt-0.5 w-full" value={draft.name} disabled={!draft.isNew} onChange={(e) => setDraft({ ...draft, name: e.target.value })} pattern="[\w-]{1,60}" required /></label>
                    <label className="text-[11px] text-muted">Script<select className="select mt-0.5 w-full" value={draft.script} onChange={(e) => setDraft({ ...draft, script: e.target.value })} required>
                        {[...new Set([draft.script, ...free.map((f) => f.script)])].filter(Boolean).map((s) => <option key={s}>{s}</option>)}</select></label>
                    <label className="text-[11px] text-muted">Arguments<input className="input mt-0.5 w-full font-mono" value={draft.args} onChange={(e) => setDraft({ ...draft, args: e.target.value })} /></label>
                    <label className="text-[11px] text-muted">Every (minutes, 0 = manual)<input className="input mt-0.5 w-full" type="number" min={0} value={draft.intervalMin} onChange={(e) => setDraft({ ...draft, intervalMin: Number(e.target.value) })} /></label>
                    <label className="text-[11px] text-muted">Reports to item<input className="input mt-0.5 w-full font-mono" value={draft.itemKey} placeholder="optional key" onChange={(e) => setDraft({ ...draft, itemKey: e.target.value })} /></label>
                    <label className="text-[11px] text-muted md:col-span-2">Note<input className="input mt-0.5 w-full" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></label>
                    <label className="flex items-end gap-1.5 text-[12px] text-dim"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Scheduled runs enabled</label>
                    <div className="flex gap-2 md:col-span-4">
                        <button className="btn-primary btn" disabled={save.isPending}>Save</button>
                        <button type="button" className="btn" onClick={() => setDraft(null)}>Cancel</button>
                        {!draft.isNew && <button type="button" className="btn ml-auto text-red-300" onClick={() => confirm(`Delete check ${draft.name}?`) && remove.mutate({ name: draft.name })}>Delete</button>}
                    </div>
                </form>
            )}
            <h2 className="mb-1 text-[12px] font-medium text-dim">Script checks</h2>
            {list.data && list.data.scripts.length === 0 && <Empty>No scheduled script checks. {free.length} script(s) in <code>scripts/chk-*.sh</code> are available to schedule.</Empty>}
            {!!list.data?.scripts.length && (
                <table className="mb-6 w-full text-[12px]">
                    <thead className="text-muted"><tr><TH>Name</TH><TH>Script</TH><TH>Schedule</TH><TH>Last run</TH><TH>Result</TH><TH /></tr></thead>
                    <tbody>
                        {list.data.scripts.map((s) => (
                            <tr key={s.name} className="border-t border-line hover:bg-hover/40">
                                <td className="px-2 py-1.5"><button className="hover:text-sky-300" onClick={() => setOpen(open === s.name ? null : s.name)}>{s.name}</button></td>
                                <td className="px-2 py-1.5 font-mono text-dim">{s.script} {s.args}</td>
                                <td className="px-2 py-1.5 text-dim">{s.intervalMin ? `every ${s.intervalMin} min${s.enabled ? '' : ' (paused)'}` : 'manual'}</td>
                                <td className="px-2 py-1.5 text-dim">{ago(s.last?.startedAt)}</td>
                                <td className="px-2 py-1.5">{s.last ? <><Pill v={s.last.status} />{s.last.flags > 0 && <span className="ml-1.5 text-amber-300">{s.last.flags} flagged</span>}</> : '-'}</td>
                                <td className="px-2 py-1.5 text-right">
                                    {may && <>
                                        <button className="mr-3 text-accent hover:underline" disabled={run.isPending} onClick={() => run.mutate({ name: s.name })}>{run.isPending && run.variables?.name === s.name ? 'Running...' : 'Run now'}</button>
                                        <button className="text-accent hover:underline" onClick={() => setDraft({ ...s, isNew: false })}>Edit</button>
                                    </>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {open && (
                <div className="mb-6 rounded-lg border border-line bg-panel/40 p-3">
                    <div className="mb-2 text-[12px] text-dim">Recent runs of {open}</div>
                    {runs.data?.length === 0 && <div className="text-[12px] text-muted">No runs yet.</div>}
                    {runs.data?.map((r) => (
                        <details key={r.id} className="border-t border-line py-1 text-[12px]">
                            <summary className="cursor-pointer"><Pill v={r.status} /> <span className="ml-2 text-dim">{ago(r.startedAt)} · {r.trigger} · {r.flags} flagged</span></summary>
                            <pre className="mt-1 max-h-64 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-dim">{r.output || '(no output)'}</pre>
                        </details>
                    ))}
                </div>
            )}
            <h2 className="mb-1 text-[12px] font-medium text-dim">Item checks</h2>
            {list.data && list.data.items.length === 0 && <Empty>No check items.</Empty>}
            {!!list.data?.items.length && (
                <table className="w-full text-[12px]">
                    <thead className="text-muted"><tr><TH>Key</TH><TH>Check</TH><TH>Cadence</TH><TH>Last run</TH><TH>State</TH><TH /></tr></thead>
                    <tbody>
                        {list.data.items.map((it) => {
                            const d = isDue({ kind: 'check', cadence: it.cadence, lastRunAt: it.lastRunAt, status: it.status } as never)
                            return (
                                <tr key={it.key} className="border-t border-line hover:bg-hover/40">
                                    <td className="px-2 py-1.5 font-mono"><Link className="hover:text-sky-300" href={`/item/${it.key}`}>{it.key}</Link></td>
                                    <td className="px-2 py-1.5">{it.title}</td>
                                    <td className="px-2 py-1.5 text-dim">{it.cadence || '-'}</td>
                                    <td className="px-2 py-1.5 text-dim">{it.lastRunAt ? ago(it.lastRunAt.getTime()) : 'never'}</td>
                                    <td className="px-2 py-1.5">{d ? <span className="rounded bg-teal-400/15 px-1.5 py-0.5 text-teal-300">due</span> : <span className="text-muted">ok</span>}</td>
                                    <td className="px-2 py-1.5 text-right">{may && !d && <button className="text-accent hover:underline" disabled={due.isPending} onClick={() => due.mutate({ key: it.key })}>Run now</button>}</td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            )}
        </Page>
    )
}
